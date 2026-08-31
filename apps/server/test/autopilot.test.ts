import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, getJson, postEmpty, postJson, withServer } from './server-helpers.ts';
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
  outcome?: string;
  auto?: boolean;
  enabled?: boolean;
  message?: string;
}

const register = {
  type: 'register',
  code: 'ABCDEFGH',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'claude', models: ['sonnet', 'haiku'] }],
};

const ask = (turnId: string, permissionId = 'per-1') => ({
  type: 'turn_permission_request',
  turnId,
  permissionId,
  tool: 'Bash',
  title: 'Bash',
  target: 'curl -s https://example.com',
  details: ['Fetch example.com'],
  suggestions: ['Bash(curl *)'],
});

interface Paired {
  cli: Recorder<CliEvent>;
  browser: Recorder<BrowserEvent>;
  sessionId: string;
  conversationId: string;
}

/** A paired session with one conversation and a browser attached to it. */
async function paired(baseUrl: string): Promise<Paired> {
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

  const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
  browser.send({ type: 'attach', sessionId });
  await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

  return { cli, browser, sessionId, conversationId: String(conversation.body['id']) };
}

/** Switches autopilot on and waits for the server to say it took. */
async function armAutopilot(
  browser: Recorder<BrowserEvent>,
  conversationId: string,
): Promise<void> {
  browser.send({ type: 'set_autopilot', conversationId, enabled: true });
  await browser.waitFor((events) =>
    events.some((event) => event.type === 'autopilot_changed' && event.enabled === true),
  );
}

/** Sends a prompt and reports the turn the CLI was asked to answer. */
async function promptFor(
  cli: Recorder<CliEvent>,
  browser: Recorder<BrowserEvent>,
  conversationId: string,
  text: string,
): Promise<string> {
  const before = cli.events.filter((event) => event.type === 'prompt').length;
  browser.send({ type: 'prompt', conversationId, text });
  await cli.waitFor((events) => events.filter((event) => event.type === 'prompt').length > before);

  const prompts = cli.events.filter((event) => event.type === 'prompt');
  return String(prompts[prompts.length - 1]?.turnId);
}

test('a conversation is created with autopilot off', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId } = await paired(baseUrl);
    const listed = await getJson(baseUrl, `/api/sessions/${sessionId}/conversations`);
    const conversations = listed.body['conversations'] as { autopilot?: boolean }[];

    // Nothing starts allowed: autopilot is something the user switches on for work
    // they are watching start, never a state a conversation arrives in.
    assert.equal(conversations[0]?.autopilot, false);

    browser.close();
    cli.close();
  });
});

test('autopilot answers an ask without putting it to the user', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await paired(baseUrl);
    await armAutopilot(browser, conversationId);

    const turnId = await promptFor(cli, browser, conversationId, 'fetch it');
    cli.send(ask(turnId));

    await cli.waitFor((events) => events.some((event) => event.type === 'permission_response'));
    const answer = cli.events.find((event) => event.type === 'permission_response');

    assert.equal(answer?.permissionId, 'per-1');
    // 'once' rather than 'always': the switch is the consent, and a lasting rule on
    // the machine would outlive the conversation that agreed to it. See ADR-059.
    assert.equal(answer?.decision, 'once');

    await browser.waitFor((events) => events.some((event) => event.type === 'permission_resolved'));
    const resolved = browser.events.find((event) => event.type === 'permission_resolved');

    assert.equal(resolved?.outcome, 'once');
    // Said so the surface can report that nobody was asked, rather than presenting
    // this as a decision somebody made.
    assert.equal(resolved?.auto, true);

    // No card is ever raised: a decision already made is not a question, and offering
    // one would be offering a choice that cannot change anything.
    assert.deepEqual(
      browser.events.filter((event) => event.type === 'permission_request'),
      [],
    );

    browser.close();
    cli.close();
  });
});

test('autopilot covers only the conversation it was switched on for', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId, conversationId } = await paired(baseUrl);
    await armAutopilot(browser, conversationId);

    const other = await postEmpty(baseUrl, `/api/sessions/${sessionId}/conversations`);
    const otherId = String(other.body['id']);

    const turnId = await promptFor(cli, browser, otherId, 'run something else');
    cli.send(ask(turnId, 'per-2'));

    // The device answers one prompt at a time, so an ask raised elsewhere is still
    // what is holding this session up. It has to reach the user.
    await browser.waitFor((events) => events.some((event) => event.type === 'permission_request'));
    const request = browser.events.find((event) => event.type === 'permission_request');

    assert.equal(request?.conversationId, otherId);
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'permission_response'),
      [],
    );

    browser.close();
    cli.close();
  });
});

test('switching autopilot off makes the next ask wait for an answer again', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await paired(baseUrl);
    await armAutopilot(browser, conversationId);

    const first = await promptFor(cli, browser, conversationId, 'fetch it');
    cli.send(ask(first));
    await cli.waitFor((events) => events.some((event) => event.type === 'permission_response'));
    cli.send({ type: 'turn_done', turnId: first, text: 'done' });

    browser.send({ type: 'set_autopilot', conversationId, enabled: false });
    await browser.waitFor((events) =>
      events.some((event) => event.type === 'autopilot_changed' && event.enabled === false),
    );

    const second = await promptFor(cli, browser, conversationId, 'fetch it again');
    cli.send(ask(second, 'per-2'));

    // Read per ask rather than remembered, so switching off takes effect on the very
    // next one instead of at the next restart.
    await browser.waitFor((events) =>
      events.some((event) => event.type === 'permission_request' && event.permissionId === 'per-2'),
    );

    assert.equal(
      cli.events.filter((event) => event.type === 'permission_response').length,
      1,
      'only the ask raised while autopilot was on was answered for the user',
    );

    browser.close();
    cli.close();
  });
});

test('a second tab is told when autopilot is switched', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, sessionId, conversationId } = await paired(baseUrl);

    const second = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    second.send({ type: 'attach', sessionId });
    await second.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'set_autopilot', conversationId, enabled: true });

    // Two tabs disagreeing about whether anybody is being asked is exactly the
    // confusion broadcasting avoids.
    await second.waitFor((events) => events.some((event) => event.type === 'autopilot_changed'));
    const changed = second.events.find((event) => event.type === 'autopilot_changed');

    assert.equal(changed?.conversationId, conversationId);
    assert.equal(changed?.enabled, true);

    second.close();
    browser.close();
    cli.close();
  });
});

test('autopilot cannot be armed on a conversation the session does not own', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, browser, conversationId } = await paired(baseUrl);

    browser.send({
      type: 'set_autopilot',
      conversationId: 'conversation-that-is-not-ours',
      enabled: true,
    });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // Arming autopilot approves every ask that follows, so a guessed id must not be
    // enough on its own. The conversation actually owned is left as it was.
    const turnId = await promptFor(cli, browser, conversationId, 'fetch it');
    cli.send(ask(turnId));

    await browser.waitFor((events) => events.some((event) => event.type === 'permission_request'));
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'permission_response'),
      [],
    );

    browser.close();
    cli.close();
  });
});
