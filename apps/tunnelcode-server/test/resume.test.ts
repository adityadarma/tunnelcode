import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  getJson,
  postEmpty,
  postJson,
  wait,
  waitUntil,
  withServer,
} from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

/**
 * What happens to a browser whose terminal was restarted.
 *
 * The session survives on purpose: the row is in the database and the device id is
 * derived from the machine and the workspace, so the next `tunnelcode` in that
 * directory answers to the same address. Surviving is not the same as being allowed,
 * and this is where the difference is checked. See ADR-040.
 */

interface CliEvent {
  type: string;
  requestId?: string;
  approvalNumber?: string;
  turnId?: string;
  message?: string;
}

interface BrowserEvent {
  type: string;
  message?: string;
  approvalNumber?: string;
  online?: boolean;
}

const registration = (code: string) => ({
  type: 'register',
  code,
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
});

interface Paired {
  cli: Recorder<CliEvent>;
  sessionId: string;
  conversationId: string;
}

async function pair(baseUrl: string, code: string): Promise<Paired> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(registration(code));
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

/**
 * Starts the CLI again for the same workspace, the way a user who pressed Ctrl+C
 * and ran the command again does: same device id, a new pairing code.
 *
 * Waits for the previous socket to be released first, because a workspace already
 * running an agent is refused and that refusal is fatal.
 */
async function restart(
  baseUrl: string,
  code: string,
  sessionId: string,
): Promise<Recorder<CliEvent>> {
  await waitUntil(async () => {
    const session = await getJson(baseUrl, `/sessions/${sessionId}`);
    return session.body['online'] === false;
  }, 'the previous agent to go offline');

  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(registration(code));
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  return cli;
}

test('a restarted terminal has to allow an attached browser again', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl, 'AAAAAAAA');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: first.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    first.cli.close();

    const cli = await restart(baseUrl, 'BBBBBBBB', first.sessionId);

    // The ask reaches the terminal without the browser having to do anything, and
    // both sides are shown the same number.
    await cli.waitFor((events) => events.some((event) => event.type === 'resume_request'));
    await browser.waitFor((events) => events.some((event) => event.type === 'resume_pending'));

    const asked = cli.events.find((event) => event.type === 'resume_request');
    const shown = browser.events.find((event) => event.type === 'resume_pending');
    assert.equal(shown?.approvalNumber, asked?.approvalNumber);

    // Until it is answered the browser has a session and no agent.
    browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'still yours?' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));
    assert.match(
      String(browser.events.find((event) => event.type === 'error')?.message),
      /Waiting for approval/,
    );
    assert.equal(
      cli.events.some((event) => event.type === 'prompt'),
      false,
      'the restarted agent should never see the prompt',
    );

    cli.send({ type: 'approve', requestId: asked?.requestId });

    // Approved, so the browser attaches again and the same prompt now lands.
    await browser.waitFor((events) => events.some((event) => event.type === 'resume_approved'));
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'still yours?' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    browser.close();
    cli.close();
  });
});

test('a browser attaching after a restart is asked about', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl, 'AAAAAAAA');
    first.cli.close();

    const cli = await restart(baseUrl, 'BBBBBBBB', first.sessionId);

    // Nothing was attached when the machine came back, so this is the other order:
    // the browser arrives and the ask is raised by the attach itself.
    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: first.sessionId });

    await browser.waitFor((events) => events.some((event) => event.type === 'resume_pending'));
    await cli.waitFor((events) => events.some((event) => event.type === 'resume_request'));

    // Nothing is attached yet, so the browser is told what it is waiting for rather
    // than being handed a session it cannot use.
    assert.equal(
      browser.events.some((event) => event.type === 'attached'),
      false,
    );

    // Reconnecting does not raise a second ask: one request is in flight, and the
    // terminal is already looking at its number.
    const again = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    again.send({ type: 'attach', sessionId: first.sessionId });
    await again.waitFor((events) => events.some((event) => event.type === 'resume_pending'));

    assert.equal(cli.events.filter((event) => event.type === 'resume_request').length, 1);

    again.close();
    browser.close();
    cli.close();
  });
});

test('a refused reconnect retires the session', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl, 'AAAAAAAA');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: first.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    first.cli.close();
    const cli = await restart(baseUrl, 'BBBBBBBB', first.sessionId);
    await cli.waitFor((events) => events.some((event) => event.type === 'resume_request'));

    const asked = cli.events.find((event) => event.type === 'resume_request');
    cli.send({ type: 'reject', requestId: asked?.requestId });

    await browser.waitFor((events) => events.some((event) => event.type === 'resume_rejected'));

    // Refusing answers "should this browser still have my machine", so it holds from
    // now on rather than only for this connection: the credential resolves to
    // nothing afterwards.
    const detail = await getJson(baseUrl, `/sessions/${first.sessionId}`);
    assert.equal(detail.status, 401);

    browser.close();
    cli.close();
  });
});

test('a dropped connection is not a restart', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl, 'AAAAAAAA');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: first.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    // The same CLI session coming back after losing its socket: one process, one
    // code, so its approvals stand. Asking again here would mean a keypress for
    // every flaky network moment.
    first.cli.close();
    const cli = await restart(baseUrl, 'AAAAAAAA', first.sessionId);

    browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'carry on' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    await wait(100);
    assert.equal(
      cli.events.some((event) => event.type === 'resume_request'),
      false,
      'a reconnect must not ask to be approved again',
    );

    browser.close();
    cli.close();
  });
});
