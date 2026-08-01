import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, getJson, postEmpty, postJson, withServer } from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

/**
 * Who may drive a conversation over the browser socket, and how long a socket that
 * has proved nothing may stay open.
 *
 * A conversation id is not a capability. It is short, it appears in a list, and it
 * outlives the session that made it, so the socket has to judge entitlement the same
 * way the HTTP routes do rather than trusting whoever sends it.
 */

interface CliEvent {
  type: string;
  turnId?: string;
  requestId?: string;
  message?: string;
  fatal?: boolean;
}

interface BrowserEvent {
  type: string;
  message?: string;
  turnId?: string;
  sessionId?: string;
}

/** ws reports this readyState once the socket is fully closed. */
const CLOSED = 3;

/**
 * Waits for the server to actually drop a socket.
 *
 * The error frame only says the server decided to; the close is what proves it did,
 * which is the whole point of the timeout.
 */
async function waitForClose<T>(recorder: Recorder<T>, timeoutMs = 5000): Promise<void> {
  if (recorder.socket.readyState === CLOSED) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The socket was never closed.'));
    }, timeoutMs);

    recorder.socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A registration for one machine and workspace. */
function registration(code: string, deviceId: string, workspace: string) {
  return {
    type: 'register',
    code,
    deviceId,
    deviceName: `Device ${deviceId}`,
    workspace,
    engines: [{ name: 'opencode', models: ['opencode/fast'] }],
  };
}

interface Paired {
  cli: Recorder<CliEvent>;
  sessionId: string;
  conversationId: string;
}

/** Pairs one machine and opens a conversation on it. */
async function pair(
  baseUrl: string,
  code: string,
  deviceId: string,
  workspace: string,
): Promise<Paired> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(registration(code, deviceId, workspace));
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/pair', { code });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);
  const sessionId = String(status.body['sessionId']);

  const conversation = await postEmpty(baseUrl, `/sessions/${sessionId}/conversations`);

  return { cli, sessionId, conversationId: String(conversation.body['id']) };
}

test('a prompt into another machine\u2019s conversation is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const mine = await pair(baseUrl, 'AAAAAAAA', 'device-1', '/work/one');
    const theirs = await pair(baseUrl, 'BBBBBBBB', 'device-2', '/work/two');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: mine.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    // A conversation id is all this sends. Accepting it would run an agent against a
    // workspace this session was never paired with.
    browser.send({
      type: 'prompt',
      conversationId: theirs.conversationId,
      text: 'do something in their workspace',
    });

    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    const error = browser.events.find((event) => event.type === 'error');
    assert.equal(error?.message, 'Unknown conversation.');

    // The refusal is the point, but so is the silence on the other side: the machine
    // that owns it should never learn the prompt was attempted.
    assert.equal(
      theirs.cli.events.some((event) => event.type === 'prompt'),
      false,
      'the owning CLI should never see the prompt',
    );

    browser.close();
    mine.cli.close();
    theirs.cli.close();
  });
});

test('a prompt into a conversation of this session still works', async () => {
  await withServer(async ({ baseUrl }) => {
    const mine = await pair(baseUrl, 'AAAAAAAA', 'device-1', '/work/one');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: mine.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({
      type: 'prompt',
      conversationId: mine.conversationId,
      text: 'do something here',
    });

    // The check must not cost anyone their own conversation, which is the failure a
    // rule stricter than the routes' would produce.
    await mine.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    assert.equal(
      browser.events.some((event) => event.type === 'error'),
      false,
    );

    browser.close();
    mine.cli.close();
  });
});

test('a conversation id that belongs to nobody is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const mine = await pair(baseUrl, 'AAAAAAAA', 'device-1', '/work/one');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: mine.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({
      type: 'prompt',
      conversationId: 'conversation-that-never-existed',
      text: 'anything',
    });

    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // Worded the same as a conversation that exists elsewhere, so the reply says
    // nothing about whether it is real.
    const error = browser.events.find((event) => event.type === 'error');
    assert.equal(error?.message, 'Unknown conversation.');

    browser.close();
    mine.cli.close();
  });
});

/** Short enough to test, standing in for the 15 seconds the app uses. */
const AUTH_MS = 80;

test('a socket that never registers is dropped', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const cli = await connect<CliEvent>(baseUrl, '/ws/cli');

      // Nothing sent. Until a CLI registers it has proved nothing, and before this
      // such a socket could sit open holding a heartbeat until the server restarted.
      await cli.waitFor((events) => events.some((event) => event.type === 'error'));

      const error = cli.events.find((event) => event.type === 'error');
      assert.equal(error?.message, 'Did not register in time.');

      // Fatal, because there is nothing to retry: it has to register, and
      // reconnecting to say nothing again would only repeat this.
      assert.equal(error?.fatal, true);

      await waitForClose(cli);
    },
    { authTimeoutMs: AUTH_MS },
  );
});

test('a socket that never attaches is dropped', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');

      await browser.waitFor((events) => events.some((event) => event.type === 'error'));

      const error = browser.events.find((event) => event.type === 'error');
      assert.equal(error?.message, 'Did not attach in time.');

      await waitForClose(browser);
    },
    { authTimeoutMs: AUTH_MS },
  );
});

test('a socket that identifies itself is left alone', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const mine = await pair(baseUrl, 'AAAAAAAA', 'device-1', '/work/one');

      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: mine.sessionId });
      await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

      // Long enough that a timer nobody disarmed would have fired by now. A pairing
      // that dropped its own connection would be worse than the problem this solves.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, AUTH_MS * 4);
      });

      assert.equal(
        browser.events.some((event) => event.type === 'error'),
        false,
        'an attached browser should not be dropped',
      );
      assert.equal(
        mine.cli.events.some((event) => event.type === 'error'),
        false,
        'a registered CLI should not be dropped',
      );

      // Still usable, which is what proves it was the timer that stopped rather than
      // the socket.
      browser.send({
        type: 'prompt',
        conversationId: mine.conversationId,
        text: 'still working',
      });
      await mine.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

      browser.close();
      mine.cli.close();
    },
    { authTimeoutMs: AUTH_MS },
  );
});
