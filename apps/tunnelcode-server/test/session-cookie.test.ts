import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, getJson, postJson, useCookie, withServer } from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

/**
 * How a browser proves which session it is.
 *
 * The credential is a cookie the page cannot read, and the session id is only an
 * address. Anything that treats the id as the claim is what this file is here to
 * catch. See ADR-041.
 */

interface CliEvent {
  type: string;
  requestId?: string;
}

interface BrowserEvent {
  type: string;
  message?: string;
}

const register = {
  type: 'register',
  code: 'ABCDEFGH',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
};

/** Pairs, and hands back the raw Set-Cookie so its attributes can be read. */
async function pair(baseUrl: string): Promise<{
  cli: Recorder<CliEvent>;
  sessionId: string;
  setCookie: string | null;
}> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(register);
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const requestId = String(request.body['requestId']);
  const response = await fetch(`${baseUrl}/pair/${requestId}/status`);
  const body = (await response.json()) as { sessionId?: string };
  const setCookie = response.headers.get('set-cookie');

  useCookie(baseUrl, setCookie === null ? undefined : (setCookie.split(';')[0] ?? undefined));

  return { cli, sessionId: String(body.sessionId), setCookie };
}

test('an approved pairing sets a cookie the page cannot read', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, setCookie } = await pair(baseUrl);

    assert.notEqual(setCookie, null);
    const cookie = setCookie ?? '';

    // HttpOnly is the point: a script that reaches the page can still make requests
    // as the user, but it cannot copy the credential and use it from anywhere else.
    assert.match(cookie, /HttpOnly/);
    // An authenticated request here can approve a tool call, so no other site gets
    // to make one in the background.
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=43200/);
    // The usual deployment is a plain address on a home network, and a Secure cookie
    // sent there is one the browser throws away.
    assert.doesNotMatch(cookie, /Secure/);

    cli.close();
  });
});

test('the token is not what the pairing response says out loud', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, setCookie } = await pair(baseUrl);

    const token = (setCookie ?? '').split(';')[0]?.split('=')[1] ?? '';

    // Two different values on purpose. The id travels in paths and is remembered by
    // the page; the token does neither.
    assert.notEqual(token, '');
    assert.notEqual(token, sessionId);

    cli.close();
  });
});

test('a browser socket with no cookie attaches to nothing', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    // The session id is real, and it is all this connection has. Before the cookie
    // it was also all a connection needed.
    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser', { cookie: '' });
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.equal(
      browser.events.find((event) => event.type === 'error')?.message,
      'Unknown session.',
    );
    assert.equal(
      browser.events.some((event) => event.type === 'attached'),
      false,
    );

    browser.close();
    cli.close();
  });
});

test('a cookie cannot attach to a session it does not name', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: 'some-other-session' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // Answered exactly as an unknown session would be, so the reply never says
    // whether the id names anything real.
    assert.equal(
      browser.events.find((event) => event.type === 'error')?.message,
      'Unknown session.',
    );

    browser.close();
    cli.close();
  });
});

test('neither the token nor the cookie reaches the log', async () => {
  const logLines: string[] = [];

  await withServer(
    async ({ baseUrl }) => {
      const { cli, setCookie } = await pair(baseUrl);
      const token = (setCookie ?? '').split(';')[0]?.split('=')[1] ?? '';

      await getJson(baseUrl, '/api/health');

      // A log outlives the session it describes and can end up somewhere the user
      // does not control, which is the same reason the pairing code is kept out.
      assert.notEqual(token, '');
      assert.equal(
        logLines.some((line) => line.includes(token)),
        false,
      );

      cli.close();
    },
    { logLines },
  );
});
