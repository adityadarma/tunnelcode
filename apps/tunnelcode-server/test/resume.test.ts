import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connect,
  currentCookie,
  getJson,
  postEmpty,
  postJson,
  useCookie,
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
  // One run of the CLI, whatever code it happens to be showing. A restart of the CLI
  // is a different value here, which is what these tests vary. See ADR-043.
  runId: 'the-first-run-of-the-cli',
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
 * and ran the command again does: same device id, a new pairing code, and a new run
 * id, because it is a new process.
 *
 * Waits for the previous socket to be released first, because a workspace already
 * running an agent is refused and that refusal is fatal.
 */
async function restart(
  baseUrl: string,
  code: string,
  sessionId: string,
  /**
   * Passing the previous run id is how a test says this is the same process coming
   * back rather than a restart. See ADR-043.
   */
  runId = 'a-later-run-of-the-cli',
): Promise<Recorder<CliEvent>> {
  await waitUntil(async () => {
    const session = await getJson(baseUrl, `/sessions/${sessionId}`);
    return session.body['online'] === false;
  }, 'the previous agent to go offline');

  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send({ ...registration(code), runId });
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

    // The same CLI session coming back after losing its socket: one process, so one
    // code and one run id, and its approvals stand. Asking again here would mean a
    // keypress for every flaky network moment.
    first.cli.close();
    const cli = await restart(baseUrl, 'AAAAAAAA', first.sessionId, 'the-first-run-of-the-cli');

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

/**
 * Updating the image replaces the process and keeps the volume, so the sessions are
 * still there and every connection has dropped. The CLI in front of the user has not
 * moved, and the browser is not asked about again. See ADR-043.
 */
async function onSameData<T>(
  databaseFile: string,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  return withServer(async ({ baseUrl }) => run(baseUrl), { databaseFile });
}

test('a server restart does not ask the terminal about anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-restart-'));
  const databaseFile = join(dir, 'restart.sqlite');

  try {
    const first = await onSameData(databaseFile, async (baseUrl) => {
      const paired = await pair(baseUrl, 'AAAAAAAA');
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: paired.sessionId });
      await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

      browser.close();
      paired.cli.close();

      return {
        sessionId: paired.sessionId,
        conversationId: paired.conversationId,
        cookie: currentCookie(baseUrl),
      };
    });

    await onSameData(databaseFile, async (baseUrl) => {
      // The same run of the CLI, reconnecting to a server that has never heard of it.
      // Its code is new only because the process would generate a new one; what says
      // it is the same run is the run id, which the sessions it approved carry.
      const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
      cli.send(registration('BBBBBBBB'));
      await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

      useCookie(baseUrl, first.cookie);
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: first.sessionId });

      // Attached, not held. Updating the image must not cost every paired browser a
      // trip to the terminal.
      await browser.waitFor((events) => events.some((event) => event.type === 'attached'));
      assert.equal(
        browser.events.some((event) => event.type === 'resume_pending'),
        false,
      );

      // And it can still drive the agent, which is the part a reinstated approval has
      // to actually mean.
      browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'still here' });
      await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

      await wait(50);
      assert.equal(
        cli.events.some((event) => event.type === 'resume_request'),
        false,
      );

      browser.close();
      cli.close();
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a restarted CLI is still asked about after a server restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-restart-'));
  const databaseFile = join(dir, 'restart.sqlite');

  try {
    const first = await onSameData(databaseFile, async (baseUrl) => {
      const paired = await pair(baseUrl, 'AAAAAAAA');
      paired.cli.close();

      return { sessionId: paired.sessionId, cookie: currentCookie(baseUrl) };
    });

    await onSameData(databaseFile, async (baseUrl) => {
      // A different run id: the user stopped the agent and started it again, and the
      // server was replaced as well. The run that agreed to this session is gone, so
      // the question stands whatever happened to the server.
      const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
      cli.send({ ...registration('BBBBBBBB'), runId: 'a-different-run-of-the-cli-entirely' });
      await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

      useCookie(baseUrl, first.cookie);
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: first.sessionId });

      await browser.waitFor((events) => events.some((event) => event.type === 'resume_pending'));
      await cli.waitFor((events) => events.some((event) => event.type === 'resume_request'));

      browser.close();
      cli.close();
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a session approved again belongs to the run that approved it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-restart-'));
  const databaseFile = join(dir, 'restart.sqlite');

  try {
    const first = await onSameData(databaseFile, async (baseUrl) => {
      const paired = await pair(baseUrl, 'AAAAAAAA');
      paired.cli.close();

      return { sessionId: paired.sessionId, cookie: currentCookie(baseUrl) };
    });

    // A second run of the CLI, which the terminal allows to serve the old session.
    const second = await onSameData(databaseFile, async (baseUrl) => {
      const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
      cli.send({ ...registration('BBBBBBBB'), runId: 'the-second-run-of-the-cli' });
      await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

      useCookie(baseUrl, first.cookie);
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: first.sessionId });
      await browser.waitFor((events) => events.some((event) => event.type === 'resume_pending'));

      const asked = cli.events.find((event) => event.type === 'resume_request');
      cli.send({ type: 'approve', requestId: asked?.requestId });
      await browser.waitFor((events) => events.some((event) => event.type === 'resume_approved'));

      browser.close();
      cli.close();

      return { cookie: currentCookie(baseUrl) };
    });

    await onSameData(databaseFile, async (baseUrl) => {
      // The server is replaced again. Approving moved the session to the second run,
      // so that run is the one recognised now; without moving it the user would be
      // asked after every restart for as long as the session lived.
      const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
      cli.send({ ...registration('CCCCCCCC'), runId: 'the-second-run-of-the-cli' });
      await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

      useCookie(baseUrl, second.cookie);
      const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
      browser.send({ type: 'attach', sessionId: first.sessionId });

      await browser.waitFor((events) => events.some((event) => event.type === 'attached'));
      assert.equal(
        browser.events.some((event) => event.type === 'resume_pending'),
        false,
      );

      browser.close();
      cli.close();
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
