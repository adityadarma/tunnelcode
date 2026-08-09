import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionService } from '../dist/services/permission.js';
import {
  connect,
  currentCookie,
  deleteJson,
  getJson,
  patchJson,
  postEmpty,
  postJson,
  useCookie,
  wait,
  withServer,
} from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

interface CliEvent {
  type: string;
  turnId?: string;
  requestId?: string;
  permissionId?: string;
  decision?: string;
}

interface BrowserEvent {
  type: string;
  conversationId?: string;
  turnId?: string;
  permissionId?: string;
  tool?: string;
  title?: string;
  target?: string;
  reason?: string;
  details?: string[];
  suggestions?: string[];
  createdAt?: number;
  expiresAt?: number;
  outcome?: string;
  message?: string;
  sessionId?: string;
}

const register = {
  type: 'register',
  code: 'ABCDEFGH',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'claude', models: ['sonnet', 'haiku'] }],
};

const ask = (turnId: string) => ({
  type: 'turn_permission_request',
  turnId,
  permissionId: 'per-1',
  tool: 'Bash',
  title: 'Bash',
  target: 'curl -s https://example.com',
  reason: 'This command requires approval',
  details: ['Fetch example.com'],
  suggestions: ['Bash(curl *)'],
});

interface Waiting {
  cli: Recorder<CliEvent>;
  browser: Recorder<BrowserEvent>;
  sessionId: string;
  conversationId: string;
  turnId: string;
}

/**
 * Brings a session to the point where an engine is holding still, waiting to be
 * allowed to run a tool call.
 */
async function waitingOnAnAsk(baseUrl: string): Promise<Waiting> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(register);
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/api/pair/${String(request.body['requestId'])}/status`);
  const sessionId = String(status.body['sessionId']);
  const conversation = await postEmpty(baseUrl, `/api/sessions/${sessionId}/conversations`);
  const conversationId = String(conversation.body['id']);

  const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
  browser.send({ type: 'attach', sessionId });
  await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

  browser.send({ type: 'prompt', conversationId, text: 'fetch it' });
  await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

  const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
  cli.send(ask(turnId));

  await browser.waitFor((events) => events.some((event) => event.type === 'permission_request'));

  return { cli, browser, sessionId, conversationId, turnId };
}

function askOf(browser: Recorder<BrowserEvent>): BrowserEvent {
  const found = browser.events.find((event) => event.type === 'permission_request');
  assert.ok(found !== undefined);
  return found;
}

test('an ask reaches the browser with everything needed to decide', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId, turnId } = await waitingOnAnAsk(baseUrl);
    const request = askOf(browser);

    assert.equal(request.conversationId, conversationId);
    assert.equal(request.turnId, turnId);
    assert.equal(request.permissionId, 'per-1');
    assert.equal(request.tool, 'Bash');
    assert.equal(request.target, 'curl -s https://example.com');
    assert.deepEqual(request.details, ['Fetch example.com']);
    assert.deepEqual(request.suggestions, ['Bash(curl *)']);

    // The deadline comes from the server so two phones cannot disagree about how
    // long is left. See ADR-022.
    assert.ok((request.expiresAt ?? 0) > (request.createdAt ?? 0));

    browser.close();
    cli.close();
  });
});

test('allowing an ask sends the decision to the waiting engine', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await waitingOnAnAsk(baseUrl);

    browser.send({
      type: 'permission_response',
      conversationId,
      permissionId: 'per-1',
      decision: 'once',
    });

    await cli.waitFor((events) => events.some((event) => event.type === 'permission_response'));
    const answer = cli.events.find((event) => event.type === 'permission_response');

    assert.equal(answer?.permissionId, 'per-1');
    assert.equal(answer?.decision, 'once');

    // Every browser is told, because the tab that did not answer would otherwise
    // keep offering a decision that has already been made.
    await browser.waitFor((events) => events.some((event) => event.type === 'permission_resolved'));
    const resolved = browser.events.find((event) => event.type === 'permission_resolved');
    assert.equal(resolved?.outcome, 'once');

    browser.close();
    cli.close();
  });
});

test('a lasting grant travels as its own decision', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await waitingOnAnAsk(baseUrl);

    browser.send({
      type: 'permission_response',
      conversationId,
      permissionId: 'per-1',
      decision: 'always',
    });

    await cli.waitFor((events) => events.some((event) => event.type === 'permission_response'));

    // Passed through rather than flattened to 'once': the machine has to know a
    // rule was granted, or it could never stop asking. See ADR-022.
    assert.equal(
      cli.events.find((event) => event.type === 'permission_response')?.decision,
      'always',
    );

    browser.close();
    cli.close();
  });
});

test('an ask can only be answered once', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await waitingOnAnAsk(baseUrl);
    const answer = { type: 'permission_response', conversationId, permissionId: 'per-1' };

    browser.send({ ...answer, decision: 'once' });
    await cli.waitFor((events) => events.some((event) => event.type === 'permission_response'));

    // A second tab answering a moment later must not reach the engine again, which
    // by then has already moved on.
    browser.send({ ...answer, decision: 'reject' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.equal(
      cli.events.filter((event) => event.type === 'permission_response').length,
      1,
      'the engine is told once',
    );

    browser.close();
    cli.close();
  });
});

test('an answer naming another conversation decides nothing', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser } = await waitingOnAnAsk(baseUrl);

    browser.send({
      type: 'permission_response',
      conversationId: 'conversation-that-is-not-ours',
      permissionId: 'per-1',
      decision: 'once',
    });

    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // An approval runs a tool call on someone's machine, so a guessed id must not
    // be enough on its own. See ADR-022.
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'permission_response'),
      [],
    );

    browser.close();
    cli.close();
  });
});

test('a browser that arrives late still sees the ask that is waiting', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId } = await waitingOnAnAsk(baseUrl);

    // What a phone that locked mid-turn does when it comes back. The engine is
    // still holding still, so the ask has to be offered again.
    const second = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    second.send({ type: 'attach', sessionId });
    await second.waitFor((events) => events.some((event) => event.type === 'permission_request'));

    assert.equal(askOf(second).permissionId, 'per-1');

    second.close();
    browser.close();
    cli.close();
  });
});

test('a finished turn takes its ask away', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId, turnId } = await waitingOnAnAsk(baseUrl);

    cli.send({ type: 'turn_done', turnId, text: 'gave up on it' });
    await browser.waitFor((events) => events.some((event) => event.type === 'permission_resolved'));

    browser.send({
      type: 'permission_response',
      conversationId,
      permissionId: 'per-1',
      decision: 'once',
    });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // Nothing is waiting for it, so the answer has nowhere to go.
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'permission_response'),
      [],
    );

    browser.close();
    cli.close();
  });
});

test('an ask nobody answers expires exactly once', async () => {
  const permissions = new PermissionService({ timeoutMs: 20 });
  const expired: string[] = [];

  const pending = permissions.add(
    {
      id: 'per-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      conversationId: 'conversation-1',
      tool: 'Bash',
      title: 'Bash',
      details: [],
      suggestions: [],
    },
    (ask) => expired.push(ask.id),
  );

  assert.equal(pending.expiresAt - pending.createdAt, 20);

  await wait(80);

  assert.deepEqual(expired, ['per-1']);
  // Taken out of the waiting set before the handler runs, so an expiry cannot
  // also be answered.
  assert.equal(permissions.resolve('turn-1', 'per-1'), undefined);
  assert.deepEqual(permissions.listBySession('session-1'), []);
});

test('answering stops the deadline', async () => {
  const permissions = new PermissionService({ timeoutMs: 20 });
  const expired: string[] = [];

  permissions.add(
    {
      id: 'per-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      conversationId: 'conversation-1',
      tool: 'Bash',
      title: 'Bash',
      details: [],
      suggestions: [],
    },
    (ask) => expired.push(ask.id),
  );

  assert.notEqual(permissions.resolve('turn-1', 'per-1'), undefined);
  await wait(80);

  // An ask that was answered must not later be reported as ignored.
  assert.deepEqual(expired, []);
});

test('a session the user ended cannot be attached or answer anything', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId, conversationId } = await waitingOnAnAsk(baseUrl);

    // Ending the session is what the Disconnect button does. Before this was
    // enforced, endedAt recorded an intention that bound nothing: the same id could
    // be attached again and still answer an ask on the machine.
    browser.send({ type: 'disconnect' });
    await cli.waitFor((events) => events.some((event) => event.type === 'stop'));

    const stale = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    stale.send({ type: 'attach', sessionId });
    await stale.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.equal(stale.events.find((event) => event.type === 'error')?.message, 'Unknown session.');

    stale.send({
      type: 'permission_response',
      conversationId,
      permissionId: 'per-1',
      decision: 'once',
    });

    // Never attached, so it was never entitled to decide anything.
    await wait(150);
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'permission_response'),
      [],
    );

    stale.close();
    browser.close();
    cli.close();
  });
});

test('an ended session is gone from the http surface too', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId } = await waitingOnAnAsk(baseUrl);

    browser.send({ type: 'disconnect' });
    await cli.waitFor((events) => events.some((event) => event.type === 'stop'));

    // The cookie is still in the browser, and it now resolves to nothing: an ended
    // session cannot authenticate at all. Returning detail here would let a browser
    // present it as live and go on creating conversations in it.
    const detail = await getJson(baseUrl, `/api/sessions/${sessionId}`);
    assert.equal(detail.status, 401);

    const created = await postEmpty(baseUrl, `/api/sessions/${sessionId}/conversations`);
    assert.equal(created.status, 401);

    browser.close();
    cli.close();
  });
});

test('a conversation id alone does not open a transcript', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId, conversationId } = await waitingOnAnAsk(baseUrl);

    // A transcript carries the output of every tool the agent ran, which is file
    // contents and command results from the user's machine. Holding an id must not
    // be enough to read that: the credential is the cookie. See ADR-041.
    const owned = currentCookie(baseUrl);

    useCookie(baseUrl, undefined);
    const anonymous = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(anonymous.status, 401);

    // A token nobody issued, which is what a guess looks like.
    useCookie(baseUrl, 'tunnelcode_session=not-a-token-this-server-ever-made');
    const invented = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(invented.status, 401);

    useCookie(baseUrl, owned);
    const owner = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(owner.status, 200);

    // The session id on its own opens nothing, which is the point of moving the
    // credential out of the page.
    useCookie(baseUrl, `tunnelcode_session=${sessionId}`);
    const idAsToken = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(idAsToken.status, 401);

    useCookie(baseUrl, owned);

    browser.close();
    cli.close();
  });
});

test('another workspace cannot read or change this conversation', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await waitingOnAnAsk(baseUrl);

    // A second machine, paired for its own workspace. Its session is perfectly
    // valid, which is what makes it the case worth testing: the check has to be
    // about entitlement, not about the id looking real.
    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'ZZZZZZZZ', deviceId: 'device-2', workspace: '/other' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));

    const request = await postJson(baseUrl, '/api/pair', { code: 'ZZZZZZZZ' });
    await other.waitFor((events) => events.some((event) => event.type === 'pair_request'));
    other.send({ type: 'approve', requestId: request.body['requestId'] });
    await other.waitFor((events) => events.some((event) => event.type === 'paired'));

    // Collecting the status is what sets the second session's cookie, so every
    // request that follows is made as that machine's browser.
    await getJson(baseUrl, `/api/pair/${String(request.body['requestId'])}/status`);

    const read = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(read.status, 404);

    const patched = await patchJson(baseUrl, `/api/conversations/${conversationId}`, {
      model: 'haiku',
    });
    assert.equal(patched.status, 404);

    // Refused before the delete runs, so a refusal never destroys anything on its
    // way out.
    const removed = await deleteJson(baseUrl, `/api/conversations/${conversationId}`);
    assert.equal(removed.status, 404);

    useCookie(baseUrl, undefined);
    const survived = await getJson(baseUrl, `/api/conversations/${conversationId}/messages`);
    assert.equal(survived.status, 401, 'still refused without a session');

    other.close();
    browser.close();
    cli.close();
  });
});
