import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  getJson,
  patchJson,
  postEmpty,
  postJson,
  waitUntil,
  withServer,
} from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

interface CliEvent {
  type: string;
  reason?: string;
  turnId?: string;
  requestId?: string;
  message?: string;
  resume?: string;
  /** Engine and model the server resolved from the conversation. */
  engine?: string;
  model?: string;
}

interface BrowserEvent {
  type: string;
  conversationId?: string;
  turnId?: string;
  role?: string;
  content?: string;
  partial?: boolean;
  text?: string;
  message?: string;
  online?: boolean;
  sessionId?: string;
  id?: string;
  tool?: string;
  target?: string;
  blocked?: boolean;
  reason?: string;
  activeTurn?: { conversationId: string; turnId: string };
}

const register = {
  type: 'register',
  code: 'ABCDEFGH',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [
    { name: 'opencode', models: ['opencode/fast', 'opencode/slow'] },
    { name: 'claude', models: ['sonnet', 'haiku'] },
  ],
};

interface Paired {
  cli: Recorder<CliEvent>;
  sessionId: string;
  conversationId: string;
}

/** Brings a session all the way to paired, which every streaming test needs. */
async function pair(baseUrl: string): Promise<Paired> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(register);
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/pair', { code: 'ABCDEFGH' });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);
  const sessionId = String(status.body['sessionId']);

  // Sent without a body, the way the browser does it: the session id is in the
  // path and there is nothing else to send.
  const conversation = await postEmpty(baseUrl, `/sessions/${sessionId}/conversations`);

  return { cli, sessionId, conversationId: String(conversation.body['id']) };
}

/** Plays the CLI side of a turn: stream fragments, then report the full answer. */
function answer(cli: Recorder<CliEvent>, turnId: string, fragments: string[]): void {
  for (const text of fragments) {
    cli.send({ type: 'delta', turnId, text });
  }
  cli.send({ type: 'turn_done', turnId, text: fragments.join('') });
}

test('the session reports every engine the machine can run', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);
    const session = await getJson(baseUrl, `/sessions/${sessionId}`);

    // The leading engine is what a new conversation starts on, and each engine
    // carries its own models so one engine's model is never offered for another.
    assert.equal(session.body['engine'], 'opencode');
    assert.equal(session.body['online'], true);
    assert.deepEqual(session.body['engines'], [
      { name: 'opencode', models: ['opencode/fast', 'opencode/slow'] },
      { name: 'claude', models: ['sonnet', 'haiku'] },
    ]);

    cli.close();
  });
});

test('a prompt reaches the CLI and its answer is stored once', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'stream please' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    answer(cli, turnId, ['Pair', 'ing ', 'works.']);

    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    const deltas = browser.events.filter((event) => event.type === 'delta');
    assert.equal(deltas.length, 3);
    assert.equal(deltas.map((event) => event.text).join(''), 'Pairing works.');

    // Deltas are relayed but never stored; only the assembled answer is.
    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as { role: string; content: string }[];

    assert.deepEqual(messages, [
      { ...messages[0], role: 'user', content: 'stream please' },
      { ...messages[1], role: 'assistant', content: 'Pairing works.' },
    ]);

    browser.close();
    cli.close();
  });
});

test('every browser on a session sees the same stream', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const first = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    first.send({ type: 'attach', sessionId });
    await first.waitFor((events) => events.some((event) => event.type === 'attached'));

    const second = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    second.send({ type: 'attach', sessionId });
    await second.waitFor((events) => events.some((event) => event.type === 'attached'));

    first.send({ type: 'prompt', conversationId, text: 'shared' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    answer(cli, turnId, ['one ', 'two']);

    await second.waitFor((events) => events.filter((event) => event.type === 'delta').length === 2);

    assert.equal(
      second.events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
      'one two',
    );

    first.close();
    second.close();
    cli.close();
  });
});

test('a prompt refused while the agent is busy is not stored', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // Arrives while the first turn is still open.
    browser.send({ type: 'prompt', conversationId, text: 'second' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(
      browser.events.find((event) => event.type === 'error')?.message ?? '',
      /still running/,
    );

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    answer(cli, turnId, ['done']);
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as { role: string; content: string }[];

    // A refused prompt must not leave a question with no answer in the history.
    assert.deepEqual(
      messages.map((message) => `${message.role}:${message.content}`),
      ['user:first', 'assistant:done'],
    );

    browser.close();
    cli.close();
  });
});

test('an empty answer is not stored', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'no answer' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    cli.send({ type: 'turn_done', turnId, text: '' });
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as { role: string }[];

    assert.deepEqual(
      messages.map((message) => message.role),
      ['user'],
    );

    browser.close();
    cli.close();
  });
});

test('a failure that produced nothing stores no answer', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'will fail' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);

    // The CLI reports no text, which is what a turn that failed before saying
    // anything looks like, and also what an older CLI always sends.
    cli.send({ type: 'turn_error', turnId, message: 'Not logged in' });

    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as { role: string }[];

    // An empty answer is nothing to keep, so only the question remains.
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user'],
    );

    browser.close();
    cli.close();
  });
});

test('a partial answer survives the failure that cut it short', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'will fail halfway' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    cli.send({ type: 'delta', turnId, text: 'I got this far' });
    cli.send({ type: 'turn_error', turnId, message: 'the engine gave up', text: 'I got this far' });

    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // Broadcast as well as stored, so a browser watching does not have to reload
    // to keep the text it already saw.
    const relayed = browser.events.find(
      (event) => event.type === 'message' && event.role === 'assistant',
    );
    assert.equal(relayed?.content, 'I got this far');
    assert.equal(relayed?.partial, true);

    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as {
      role: string;
      content: string;
      partial: boolean;
    }[];

    // The user watched this text arrive, so a reload that dropped it would look
    // like the work never happened.
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant'],
    );
    assert.equal(messages[1]?.content, 'I got this far');

    // Flagged rather than stored as an ordinary answer, so the transcript never
    // presents a truncated reply as a finished one.
    assert.equal(messages[1]?.partial, true);

    browser.close();
    cli.close();
  });
});

test('a model belonging to another engine is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    // sonnet is real, but it belongs to claude. Refused at creation, so the
    // conversation is never left in a state it cannot answer in. See ADR-020.
    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'opencode',
      model: 'sonnet',
    });

    assert.equal(created.status, 400);
    assert.match(String(created.body['error']), /not available/);

    cli.close();
  });
});

test('a model of the chosen engine is accepted and used', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'claude',
      model: 'haiku',
    });

    assert.equal(created.status, 201);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId: String(created.body['id']), text: 'hi' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // The prompt carries what the conversation chose, not what the browser sent:
    // the browser sends neither.
    const prompt = cli.events.find((event) => event.type === 'prompt');
    assert.equal(prompt?.engine, 'claude');
    assert.equal(prompt?.model, 'haiku');

    browser.close();
    cli.close();
  });
});

test('a conversation keeps its engine for every prompt', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'claude',
    });
    const conversationId = String(created.body['id']);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const first = cli.events.find((event) => event.type === 'prompt');
    answer(cli, String(first?.turnId), ['ok']);
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    browser.send({ type: 'prompt', conversationId, text: 'second' });
    await cli.waitFor(() => cli.events.filter((event) => event.type === 'prompt').length === 2);

    // The engine is fixed for the life of the conversation, because the agent's
    // context lives in an engine session.
    assert.deepEqual(
      cli.events.filter((event) => event.type === 'prompt').map((event) => event.engine),
      ['claude', 'claude'],
    );

    browser.close();
    cli.close();
  });
});

test('the model of a conversation can be changed', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'opencode',
      model: 'opencode/fast',
    });
    const conversationId = String(created.body['id']);

    const patched = await patchJson(baseUrl, `/conversations/${conversationId}`, {
      model: 'opencode/slow',
    });

    assert.equal(patched.status, 200);
    assert.equal(patched.body['model'], 'opencode/slow');

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'hi' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // A model swap stays inside the same engine, so the engine session survives it.
    const prompt = cli.events.find((event) => event.type === 'prompt');
    assert.equal(prompt?.engine, 'opencode');
    assert.equal(prompt?.model, 'opencode/slow');

    browser.close();
    cli.close();
  });
});

test('the engine of a conversation cannot be changed', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'opencode',
    });
    const conversationId = String(created.body['id']);

    // Sent the way a client that assumed engines were switchable would send it.
    // The field is ignored rather than honoured, and the model is validated against
    // the engine the conversation already has.
    const patched = await patchJson(baseUrl, `/conversations/${conversationId}`, {
      engine: 'claude',
      model: 'sonnet',
    });

    assert.equal(patched.status, 400);
    assert.match(String(patched.body['error']), /not available/);

    cli.close();
  });
});

test('a conversation cannot be created on an engine the machine lacks', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const created = await postJson(baseUrl, `/sessions/${sessionId}/conversations`, {
      engine: 'gemini',
    });

    assert.equal(created.status, 400);
    assert.match(String(created.body['error']), /not available/);

    cli.close();
  });
});

test('a prompt before attaching is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'prompt', conversationId: 'c1', text: 'hi' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(browser.events.at(-1)?.message ?? '', /Not attached/);
    browser.close();
  });
});

test('attaching to an unknown session fails', async () => {
  await withServer(async ({ baseUrl }) => {
    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: 'nope' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(browser.events.at(-1)?.message ?? '', /Unknown session/);
    browser.close();
  });
});

test('an unknown conversation is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId: 'nope', text: 'hi' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(browser.events.at(-1)?.message ?? '', /Unknown conversation/);

    browser.close();
    cli.close();
  });
});

test('the browser learns when the device goes offline', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    cli.close();
    await browser.waitFor((events) =>
      events.some((event) => event.type === 'device_status' && event.online === false),
    );

    browser.send({ type: 'prompt', conversationId, text: 'hi' });
    await browser.waitFor((events) =>
      events.some((event) => (event.message ?? '').includes('offline')),
    );

    browser.close();
  });
});

test('a turn left open by a disconnect is ended', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'hi' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    cli.close();

    // Without this the browser would wait for an answer that can never arrive.
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    browser.close();
  });
});

test('history is reloaded after the browser reconnects', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const first = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    first.send({ type: 'attach', sessionId });
    await first.waitFor((events) => events.some((event) => event.type === 'attached'));

    first.send({ type: 'prompt', conversationId, text: 'before refresh' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    answer(cli, turnId, ['kept']);
    await first.waitFor((events) => events.some((event) => event.type === 'turn_done'));
    first.close();

    // A refresh reattaches and reloads over HTTP, it does not pair again.
    const second = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    second.send({ type: 'attach', sessionId });
    await second.waitFor((events) => events.some((event) => event.type === 'attached'));

    const stored = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const messages = stored.body['messages'] as { role: string; content: string }[];

    assert.deepEqual(
      messages.map((message) => `${message.role}:${message.content}`),
      ['user:before refresh', 'assistant:kept'],
    );

    second.close();
    cli.close();
  });
});

test('the conversation is titled from the first prompt', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'name this conversation' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const listed = await getJson(baseUrl, `/sessions/${sessionId}/conversations`);
    const conversations = listed.body['conversations'] as { id: string; title: string | null }[];

    assert.equal(
      conversations.find((item) => item.id === conversationId)?.title,
      'name this conversation',
    );

    browser.close();
    cli.close();
  });
});

test('a browser disconnect tells the CLI to stop', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'disconnect' });

    // The agent runs on the paired machine, so ending the session has to reach
    // the CLI. Clearing the browser alone would leave a terminal waiting.
    await cli.waitFor((events) => events.some((event) => event.type === 'stop'));

    browser.close();
    cli.close();
  });
});

test('the first prompt in a conversation has nothing to resume', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first question' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    // No engine conversation exists yet, so the engine has to start fresh.
    assert.equal(cli.events.find((event) => event.type === 'prompt')?.resume, undefined);

    browser.close();
    cli.close();
  });
});

test('a later prompt continues the engine conversation', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first question' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const firstTurn = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_session', turnId: firstTurn, engineSessionId: 'engine-session-1' });
    cli.send({ type: 'turn_done', turnId: firstTurn, text: 'first answer' });
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    browser.send({ type: 'prompt', conversationId, text: 'follow up' });
    await cli.waitFor((events) => events.filter((event) => event.type === 'prompt').length === 2);

    // This is what gives the agent memory of what was already said here.
    const second = cli.events.filter((event) => event.type === 'prompt').at(1);
    assert.equal(second?.resume, 'engine-session-1');

    browser.close();
    cli.close();
  });
});

test('a new conversation starts its own engine conversation', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first question' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const firstTurn = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_session', turnId: firstTurn, engineSessionId: 'engine-session-1' });
    cli.send({ type: 'turn_done', turnId: firstTurn, text: 'first answer' });
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    // A second conversation must not inherit the first one's agent context.
    const other = await postEmpty(baseUrl, `/sessions/${sessionId}/conversations`);
    const otherId = String(other.body['id']);

    browser.send({ type: 'prompt', conversationId: otherId, text: 'unrelated question' });
    await cli.waitFor((events) => events.filter((event) => event.type === 'prompt').length === 2);

    const second = cli.events.filter((event) => event.type === 'prompt').at(1);
    assert.equal(second?.resume, undefined);

    browser.close();
    cli.close();
  });
});

test('a session reported for another device is ignored', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first question' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';

    // A second CLI claims the engine session for a turn it does not own.
    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'QQQQQQQQ', deviceId: 'device-2', workspace: '/other' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));
    other.send({ type: 'turn_session', turnId, engineSessionId: 'stolen-session' });

    cli.send({ type: 'turn_done', turnId, text: 'first answer' });
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    browser.send({ type: 'prompt', conversationId, text: 'follow up' });
    await cli.waitFor((events) => events.filter((event) => event.type === 'prompt').length === 2);

    // Accepting it would let one machine redirect another's conversation into an
    // engine session it controls.
    const second = cli.events.filter((event) => event.type === 'prompt').at(1);
    assert.equal(second?.resume, undefined);

    other.close();
    browser.close();
    cli.close();
  });
});

test('an activity reaches the browser', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'change a file' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_activity', turnId, id: 'act1', tool: 'Write', target: 'src/a.ts' });

    await browser.waitFor((events) => events.some((event) => event.type === 'activity'));

    const activity = browser.events.find((event) => event.type === 'activity');
    assert.equal(activity?.tool, 'Write');
    assert.equal(activity?.target, 'src/a.ts');
    assert.equal(activity?.conversationId, conversationId);

    browser.close();
    cli.close();
  });
});

test('an activity is stored for a later refresh', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'change a file' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_activity', turnId, id: 'act1', tool: 'Bash', target: 'pnpm test' });
    await browser.waitFor((events) => events.some((event) => event.type === 'activity'));

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const activities = reloaded.body['activities'] as { tool: string; target?: string }[];

    // A refresh reloads the transcript, so the tool call has to come back with it.
    assert.deepEqual(
      activities.map((item) => item.tool),
      ['Bash'],
    );
    assert.equal(activities[0]?.target, 'pnpm test');

    browser.close();
    cli.close();
  });
});

test('an activity is kept when the turn fails', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'change a file then fail' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_activity', turnId, id: 'act1', tool: 'Write', target: 'src/a.ts' });
    await browser.waitFor((events) => events.some((event) => event.type === 'activity'));

    cli.send({ type: 'turn_error', turnId, message: 'the engine gave up' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const activities = reloaded.body['activities'] as unknown[];

    // The file was already changed, so hiding that because the answer failed
    // would leave the user unaware of what happened on their machine.
    assert.equal(activities.length, 1);

    browser.close();
    cli.close();
  });
});

test('an activity for another device is ignored', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'change a file' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';

    // A second CLI reports against a turn it does not own.
    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'QQQQQQQQ', deviceId: 'device-2', workspace: '/other' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));
    other.send({ type: 'turn_activity', turnId, id: 'act1', tool: 'Write', target: '/etc/passwd' });

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);

    // Writing into another device's turn would let one machine fake activity in
    // somebody else's conversation.
    assert.deepEqual(reloaded.body['activities'], []);

    other.close();
    browser.close();
    cli.close();
  });
});

test('a conversation is created without a body', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    // Everything the route needs is in the path, so a body would be pointless.
    // Declaring json and sending nothing is what made this fail.
    const created = await postEmpty(baseUrl, `/sessions/${sessionId}/conversations`);

    assert.equal(created.status, 201);
    assert.equal(typeof created.body['id'], 'string');

    cli.close();
  });
});

test('a conversation is not created for an unknown session', async () => {
  await withServer(async ({ baseUrl }) => {
    const created = await postEmpty(baseUrl, '/sessions/does-not-exist/conversations');

    // A guessed session id must not get a conversation to write into.
    assert.equal(created.status, 404);
  });
});

/**
 * Pairs again as the same workspace on the same machine, the way a user who
 * restarted the agent does: a fresh code, but the same device id and workspace.
 *
 * The old CLI has to be gone first, because a workspace already running an agent
 * is refused, so this waits for the code to become usable rather than sleeping a
 * fixed amount.
 */
async function repair(
  baseUrl: string,
  code: string,
  previousSessionId: string,
): Promise<{ cli: Recorder<CliEvent>; sessionId: string }> {
  // Registering while the server still sees the old socket is refused as a busy
  // workspace, and that refusal is fatal. The session going offline is the server
  // saying it has processed the close and released the workspace.
  await waitUntil(async () => {
    const session = await getJson(baseUrl, `/sessions/${previousSessionId}`);
    return session.body['online'] === false;
  }, 'the previous agent to go offline');

  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send({ ...register, code });
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/pair', { code });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);

  return { cli, sessionId: String(status.body['sessionId']) };
}

test('pairing again reopens the same conversation list', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: first.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));
    browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'asked earlier' });
    await first.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));
    browser.close();
    first.cli.close();

    // The agent is restarted, which pairs a new session for the same workspace.
    const second = await repair(baseUrl, 'ZZZZZZZZ', first.sessionId);
    assert.notEqual(second.sessionId, first.sessionId);

    const listed = await getJson(baseUrl, `/sessions/${second.sessionId}/conversations`);
    const conversations = listed.body['conversations'] as { id: string }[];

    // Scoped to the session alone this would be empty, leaving the user staring at
    // a fresh list while their history sat under the previous id.
    assert.deepEqual(
      conversations.map((item) => item.id),
      [first.conversationId],
    );

    second.cli.close();
  });
});

test('a conversation from an earlier session can still be continued', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await pair(baseUrl);
    first.cli.close();

    const second = await repair(baseUrl, 'ZZZZZZZZ', first.sessionId);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId: second.sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    // Listing it without being able to ask in it would be a dead end.
    browser.send({ type: 'prompt', conversationId: first.conversationId, text: 'still here?' });
    await second.cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = second.cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    answer(second.cli, turnId, ['yes']);
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    const stored = await getJson(baseUrl, `/conversations/${first.conversationId}/messages`);
    const messages = stored.body['messages'] as { content: string }[];

    // One transcript across both pairings, not two disjoint halves.
    assert.deepEqual(
      messages.map((item) => item.content),
      ['still here?', 'yes'],
    );

    browser.close();
    second.cli.close();
  });
});

test('another workspace on the same machine keeps its own list', async () => {
  await withServer(async ({ baseUrl }) => {
    const mine = await pair(baseUrl);

    // A different directory is a different device id, so its history must stay
    // separate even though the same person is on the same machine.
    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'QQQQQQQQ', deviceId: 'device-2', workspace: '/other' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));

    const request = await postJson(baseUrl, '/pair', { code: 'QQQQQQQQ' });
    await other.waitFor((events) => events.some((event) => event.type === 'pair_request'));
    other.send({ type: 'approve', requestId: request.body['requestId'] });
    await other.waitFor((events) => events.some((event) => event.type === 'paired'));

    const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);
    const otherSessionId = String(status.body['sessionId']);

    const listed = await getJson(baseUrl, `/sessions/${otherSessionId}/conversations`);

    assert.deepEqual(listed.body['conversations'], []);

    // And the original list is untouched by the second workspace existing.
    const original = await getJson(baseUrl, `/sessions/${mine.sessionId}/conversations`);
    const conversations = original.body['conversations'] as { id: string }[];
    assert.deepEqual(
      conversations.map((item) => item.id),
      [mine.conversationId],
    );

    other.close();
    mine.cli.close();
  });
});

test('conversations are not listed for an unknown session', async () => {
  await withServer(async ({ baseUrl }) => {
    const listed = await getJson(baseUrl, '/sessions/does-not-exist/conversations');

    // Widening the list to a workspace must not widen who can read it.
    assert.equal(listed.status, 404);
  });
});

test('attaching mid-answer reports the turn still running', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'takes a while' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);

    // The user refreshes while the answer is still being written.
    browser.close();

    const reopened = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    reopened.send({ type: 'attach', sessionId });
    await reopened.waitFor((events) => events.some((event) => event.type === 'attached'));

    const attached = reopened.events.find((event) => event.type === 'attached');

    // Without this the browser would show an idle composer and have its next
    // prompt refused with no way to know why.
    assert.deepEqual(attached?.activeTurn, { conversationId, turnId });

    reopened.close();
    cli.close();
  });
});

test('attaching with nothing running reports no turn', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    // Absent rather than a placeholder, so an idle session stays plainly idle.
    assert.equal(browser.events.find((event) => event.type === 'attached')?.activeTurn, undefined);

    browser.close();
    cli.close();
  });
});

test('a finished turn is no longer reported on attach', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'quick one' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    answer(cli, turnId, ['done']);
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));
    browser.close();

    const reopened = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    reopened.send({ type: 'attach', sessionId });
    await reopened.waitFor((events) => events.some((event) => event.type === 'attached'));

    // A stale turn would leave the composer disabled forever.
    assert.equal(reopened.events.find((event) => event.type === 'attached')?.activeTurn, undefined);

    reopened.close();
    cli.close();
  });
});

test('a prompt refused while busy explains that the answer is coming', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'first' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    browser.send({ type: 'prompt', conversationId, text: 'second' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    // "The agent is still answering." was accurate but left the user with no idea
    // what to do next.
    assert.match(browser.events.at(-1)?.message ?? '', /still running/);
    assert.match(browser.events.at(-1)?.message ?? '', /appear here when it finishes/);

    browser.close();
    cli.close();
  });
});

test('a disconnect before attaching is refused', async () => {
  await withServer(async ({ baseUrl }) => {
    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'disconnect' });
    await browser.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(browser.events.at(-1)?.message ?? '', /Not attached/);
    browser.close();
  });
});

test('a refused tool call is stored and marked as blocked', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'write outside the workspace' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({
      type: 'turn_blocked',
      turnId,
      tool: 'Write',
      reason: "requested permissions to write to /outside/note.txt, but you haven't granted it yet",
    });
    await browser.waitFor((events) => events.some((event) => event.type === 'activity'));

    const relayed = browser.events.find((event) => event.type === 'activity');
    assert.equal(relayed?.blocked, true);
    assert.equal(relayed?.tool, 'Write');
    assert.match(relayed?.reason ?? '', /requested permissions/);

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const activities = reloaded.body['activities'] as { tool: string; blocked: boolean }[];

    // A refusal is part of what the turn attempted, so a refresh has to show it
    // rather than leaving the answer that followed without a cause.
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.blocked, true);

    browser.close();
    cli.close();
  });
});

test('a tool call that ran is not marked as blocked', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'run the tests' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';
    cli.send({ type: 'turn_activity', turnId, id: 'act1', tool: 'Bash', target: 'pnpm test' });
    await browser.waitFor((events) => events.some((event) => event.type === 'activity'));

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);
    const activities = reloaded.body['activities'] as { blocked: boolean }[];

    assert.equal(activities[0]?.blocked, false);

    browser.close();
    cli.close();
  });
});

test('a refusal reported for another device is ignored', async () => {
  await withServer(async ({ baseUrl }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    browser.send({ type: 'prompt', conversationId, text: 'do something' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const turnId = cli.events.find((event) => event.type === 'prompt')?.turnId ?? '';

    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'QQQQQQQQ', deviceId: 'device-2', workspace: '/other' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));
    other.send({ type: 'turn_blocked', turnId, tool: 'Write', reason: 'rejected permission' });

    const reloaded = await getJson(baseUrl, `/conversations/${conversationId}/messages`);

    // Writing into another device's turn would let one machine fake a refusal in
    // somebody else's conversation.
    assert.deepEqual(reloaded.body['activities'], []);

    other.close();
    browser.close();
    cli.close();
  });
});
