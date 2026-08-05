import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  currentCookie,
  getJson,
  postEmpty,
  postJson,
  useCookie,
  wait,
  withServer,
} from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

/**
 * Stopping an answer that is running.
 *
 * The turn is ended on the server before the machine is told, which is the opposite
 * of how the rest of a turn works and is the whole point: the answer worth stopping
 * is often one whose engine has stopped responding, and waiting for that engine to
 * confirm would be waiting on the thing that is stuck. See ADR-042.
 */

interface CliEvent {
  type: string;
  requestId?: string;
  turnId?: string;
  text?: string;
}

interface BrowserEvent {
  type: string;
  message?: string;
  conversationId?: string;
  turnId?: string;
  role?: string;
  content?: string;
  partial?: boolean;
  interruption?: string;
  permissionId?: string;
  outcome?: string;
}

const registration = (code: string, deviceId: string, workspace: string) => ({
  type: 'register',
  code,
  deviceId,
  deviceName: `Device ${deviceId}`,
  workspace,
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
});

interface Paired {
  cli: Recorder<CliEvent>;
  browser: Recorder<BrowserEvent>;
  sessionId: string;
  conversationId: string;
  cookie: string | undefined;
}

/** Pairs, opens a conversation, and attaches a browser to it. */
async function pair(
  baseUrl: string,
  code = 'ABCDEFGH',
  deviceId = 'device-1',
  workspace = '/work',
): Promise<Paired> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(registration(code, deviceId, workspace));
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));
  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/api/pair/${String(request.body['requestId'])}/status`);
  const sessionId = String(status.body['sessionId']);
  const conversation = await postEmpty(baseUrl, `/api/sessions/${sessionId}/conversations`);

  const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
  browser.send({ type: 'attach', sessionId });
  await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

  return {
    cli,
    browser,
    sessionId,
    conversationId: String(conversation.body['id']),
    cookie: currentCookie(baseUrl),
  };
}

/** Sends a prompt and hands back the turn the browser was told about. */
async function ask(paired: Paired, text: string): Promise<string> {
  paired.browser.send({ type: 'prompt', conversationId: paired.conversationId, text });
  await paired.browser.waitFor((events) => events.some((event) => event.type === 'turn_started'));

  const started = paired.browser.events.filter((event) => event.type === 'turn_started');
  return String(started[started.length - 1]?.turnId);
}

test('the browser is told the turn id before any output arrives', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'takes a while');

    // Without this the id only arrived with the first fragment of output, so a turn
    // whose engine said nothing at all could not be named, and it is exactly the one
    // that needs stopping.
    assert.notEqual(turnId, 'undefined');
    assert.equal(
      paired.browser.events.some((event) => event.type === 'delta'),
      false,
    );

    paired.browser.close();
    paired.cli.close();
  });
});

test('a stuck answer can be stopped and the device is free again', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'hangs forever');

    await paired.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // The engine never says anything, which is what being stuck looks like from here.
    paired.browser.send({ type: 'stop_turn', turnId });

    // The machine is told to kill it, and the turn ends without waiting to hear back.
    await paired.cli.waitFor((events) => events.some((event) => event.type === 'stop_turn'));
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    const record = paired.browser.events.find(
      (event) => event.type === 'message' && event.role === 'assistant',
    );
    assert.equal(record?.partial, true);
    // A stop is not a fault, and the record says which of the two happened.
    assert.equal(record?.interruption, 'stopped');
    assert.equal(
      paired.browser.events.some((event) => event.type === 'error'),
      false,
      'stopping is not an error',
    );

    // The point of stopping: a device answers one prompt at a time, so a turn nobody
    // can end is a session nobody can use.
    paired.browser.send({ type: 'prompt', conversationId: paired.conversationId, text: 'again' });
    await paired.cli.waitFor(
      (events) => events.filter((event) => event.type === 'prompt').length === 2,
    );

    paired.browser.close();
    paired.cli.close();
  });
});

test('what the answer had already said is kept, marked as stopped', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'say something first');

    await paired.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));
    paired.cli.send({ type: 'delta', turnId, text: 'I was getting to it' });
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'delta'));

    paired.browser.send({ type: 'stop_turn', turnId });
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    // The user watched this arrive, so a reload that made it disappear would look
    // like the work never happened. See ADR-033.
    const stored = await getJson(baseUrl, `/api/conversations/${paired.conversationId}/messages`);
    const messages = stored.body['messages'] as {
      role: string;
      content: string;
      partial: boolean;
      interruption: string | null;
    }[];

    assert.deepEqual(
      messages.map((message) => message.content),
      ['say something first', 'I was getting to it'],
    );
    assert.equal(messages[1]?.partial, true);
    assert.equal(messages[1]?.interruption, 'stopped');

    paired.browser.close();
    paired.cli.close();
  });
});

test('anything the engine reports after a stop is dropped', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'stop me');

    await paired.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));
    paired.browser.send({ type: 'stop_turn', turnId });
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    // A CLI that had not read the stop yet, finishing the turn it was told to kill.
    paired.cli.send({ type: 'delta', turnId, text: 'ignored' });
    paired.cli.send({ type: 'turn_done', turnId, text: 'ignored answer' });
    await wait(100);

    // The turn is gone here, so its late reports have nowhere to land: an answer the
    // user stopped must not appear in the transcript afterwards.
    const stored = await getJson(baseUrl, `/api/conversations/${paired.conversationId}/messages`);
    const messages = stored.body['messages'] as { content: string }[];

    assert.deepEqual(
      messages.map((message) => message.content),
      ['stop me', ''],
    );

    paired.browser.close();
    paired.cli.close();
  });
});

test('stopping clears an ask the engine was waiting on', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'run something');

    await paired.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));
    paired.cli.send({
      type: 'turn_permission_request',
      turnId,
      permissionId: 'per-1',
      tool: 'Bash',
      title: 'Run a command',
      details: ['rm -rf /'],
      suggestions: [],
    });
    await paired.browser.waitFor((events) =>
      events.some((event) => event.type === 'permission_request'),
    );

    paired.browser.send({ type: 'stop_turn', turnId });
    await paired.browser.waitFor((events) =>
      events.some((event) => event.type === 'permission_resolved'),
    );

    // The engine is being killed, so a card still offering to allow this would be a
    // button that goes nowhere.
    const resolved = paired.browser.events.find((event) => event.type === 'permission_resolved');
    assert.equal(resolved?.permissionId, 'per-1');

    paired.browser.close();
    paired.cli.close();
  });
});

test('a stop for a turn that is over says so', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);
    const turnId = await ask(paired, 'quick one');

    await paired.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));
    paired.cli.send({ type: 'turn_done', turnId, text: 'done already' });
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    // The ordinary way this happens is a tap that lands just after the answer
    // finished, so it is reported plainly rather than treated as an attack.
    paired.browser.send({ type: 'stop_turn', turnId });
    await paired.browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(
      String(paired.browser.events.find((event) => event.type === 'error')?.message),
      /no longer running/,
    );

    paired.browser.close();
    paired.cli.close();
  });
});

test('a stop aimed at another machine’s turn is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const mine = await pair(baseUrl);
    const theirs = await pair(baseUrl, 'BBBBBBBB', 'device-2', '/other');
    const turnId = await ask(theirs, 'their work');

    await theirs.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // A turn id is not a capability. Accepting this would kill an agent on a machine
    // this session never paired with.
    useCookie(baseUrl, mine.cookie);
    mine.browser.send({ type: 'stop_turn', turnId });
    await mine.browser.waitFor((events) => events.some((event) => event.type === 'error'));

    await wait(100);
    assert.equal(
      theirs.cli.events.some((event) => event.type === 'stop_turn'),
      false,
      'the owning machine should never be told to stop',
    );
    assert.equal(
      theirs.browser.events.some((event) => event.type === 'turn_done'),
      false,
      'the owning session keeps its answer',
    );

    mine.browser.close();
    theirs.browser.close();
    mine.cli.close();
    theirs.cli.close();
  });
});
