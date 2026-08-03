import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiroEngine } from '../dist/adapters/kiro.js';
import type { EngineEvent, EnginePermissionRequest, PromptOptions } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fakes built from traffic recorded from kiro-cli 2.16.0 over `kiro-cli acp`.
 *
 * The shapes here are the ones the real agent sent, which is why they are narrower
 * than the protocol allows: a permission ask carries only the id and title of the
 * call it is about, a continued conversation is loaded rather than resumed, and the
 * engine names its own tool in a `_meta` field beside ACP's coarser kind.
 *
 * The framing is one JSON object per line, which is what ACP uses over stdio.
 */

/**
 * Builds a fake agent from a script fragment.
 *
 * The fragment is a body with `send(obj)` for writing a line, and `on(msg)` called
 * for every line the adapter writes. Boilerplate is shared because a fake that
 * cannot answer initialize never reaches the part a test is about.
 */
function agent(body: string): string {
  return `#!/usr/bin/env node
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    handle(JSON.parse(line));
  }
});
${body}
`;
}

/** Answers the handshake and the session, then runs a test's own body. */
function conversation(turn: string, options: { sessionId?: string } = {}): string {
  const sessionId = options.sessionId ?? 'sess_abc123';

  return agent(`
const SESSION = ${JSON.stringify(sessionId)};
const update = (id, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: u } });
const text = (t) => ({ type: 'text', text: t });

/**
 * Asks about a tool call the way the real agent does: the call itself was
 * announced in an earlier update, and the ask carries only its id and title.
 */
const ask = (toolCallId, title, options) =>
  send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: SESSION, toolCall: { toolCallId, title }, options } });

/** The three answers the agent offers, worded as it words them. */
const YES_ALWAYS_NO = [
  { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
];

function handle(msg) {
  // The answer to an ask, which is a result carrying an outcome. What was chosen
  // is said out loud so a test can read the decision that reached the agent.
  if (msg.result && msg.result.outcome) {
    const outcome = msg.result.outcome;
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text(outcome.outcome === 'selected' ? 'chose:' + outcome.optionId : 'cancelled') });
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: false }, sessionCapabilities: {} }, authMethods: [], agentInfo: { name: 'Kiro CLI Agent', version: '2.16.0' } } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION, models: { currentModelId: 'auto', availableModels: [{ modelId: 'auto', name: 'auto' }, { modelId: 'claude-sonnet-4.5', name: 'claude-sonnet-4.5' }] } } });
    return;
  }
  // Loading replays the whole transcript before it answers, which is what the
  // real agent does.
  if (msg.method === 'session/load') {
    global.loaded = true;
    update(msg.params.sessionId, { sessionUpdate: 'user_message_chunk', content: text('an earlier question') });
    update(msg.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('an earlier answer') });
    update(msg.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old_call', title: 'Running: ls', kind: 'execute', rawInput: { command: 'ls' }, _meta: { kiro: { toolName: 'shell' } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: { currentModeId: 'kiro_default', availableModes: [] } } });
    return;
  }
  if (msg.method === 'session/set_model') {
    global.model = msg.params.modelId;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    ${turn}
    return;
  }
  if (msg.method === 'session/cancel') {
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
    return;
  }
}
`);
}

/** Ends a turn the way ACP does, with a stop reason on the prompt's own answer. */
const endTurn = `send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });`;

async function collect(events: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];

  for await (const event of events) {
    out.push(event);
  }

  return out;
}

function textOf(events: EngineEvent[]): string {
  return events
    .filter((event): event is Extract<EngineEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

/** The thinking, assembled from the events that carry it and nothing else. */
function reasoningOf(events: EngineEvent[]): string {
  return events
    .filter(
      (event): event is Extract<EngineEvent, { type: 'reasoning' }> => event.type === 'reasoning',
    )
    .map((event) => event.text)
    .join('');
}

type Activity = Extract<EngineEvent, { type: 'activity' }>;

function activitiesOf(events: EngineEvent[]): Activity[] {
  return events.filter((event): event is Activity => event.type === 'activity');
}

const base: PromptOptions = { cwd: process.cwd() };

test('streamed chunks are forwarded in order', async () => {
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('Hel') });
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('lo ') });
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('world') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'Hello world');
  });
});

test('thinking is reported as itself, not as the answer', async () => {
  // ACP reports thinking as a chunk of its own, carrying the same text content as
  // an answer. Reported as reasoning, so the reader can open it without ever being
  // shown the model working itself out as though it were speaking to them.
  // See ADR-037.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_thought_chunk', content: text('The user wants X, so I should check the files.') });
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('Here is the answer.') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'Here is the answer.');
    assert.equal(reasoningOf(events), 'The user wants X, so I should check the files.');
  });
});

test('the prompt is never replayed as the answer', async () => {
  // The user's own words come back as a chunk that reads exactly like an answer.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'user_message_chunk', content: text('what did I ask') });
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('the answer') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('what did I ask', base));
    assert.equal(textOf(events), 'the answer');
  });
});

test('a tool call is reported once, named as the engine names it', async () => {
  // Recorded from a shell command: the call is announced with its arguments and no
  // status at all, the output arrives on its own, and the closing update repeats
  // the coarse kind without the tool name.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tooluse_1', title: 'Running: echo probe', kind: 'execute', rawInput: { command: 'echo probe' }, _meta: { kiro: { toolName: 'shell' } } });
    update(SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'tooluse_1', content: [{ type: 'content', content: text('probe\\n') }] });
    update(SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'tooluse_1', kind: 'execute', status: 'completed', title: 'Running: echo probe', rawInput: { command: 'echo probe' }, rawOutput: { items: [{ Json: { exit_status: 'exit status: 0', stdout: 'probe\\n', stderr: '' } }] } });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities.length, 1);
    // 'shell' is the tool, where 'execute' is the category several tools share, so
    // a rule written on this machine names the one that ran.
    assert.equal(activities[0]?.tool, 'shell');
    assert.equal(activities[0]?.target, 'echo probe');

    const outputs = events.filter((event) => event.type === 'activity_output');

    // Once, not twice: the structured result repeats the same output the content
    // already carried.
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.type === 'activity_output' ? outputs[0].output : '', 'probe\n');
  });
});

test('a tool that only summarises itself still reports what it did', async () => {
  // Recorded from a file write: nothing arrives as content, the diff carries the
  // whole new file, and the summary is in the tool's own result.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tooluse_2', title: 'Creating note.txt', kind: 'edit', content: [{ type: 'diff', path: '/private/tmp/work/note.txt', oldText: null, newText: 'probe\\n' }], locations: [{ path: 'note.txt', line: 1 }], rawInput: { command: 'create', path: 'note.txt', content: 'probe\\n' }, _meta: { kiro: { toolName: 'write' } } });
    update(SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'tooluse_2', kind: 'edit', status: 'completed', title: 'Creating note.txt', locations: [{ path: 'note.txt', line: 1 }], rawInput: { command: 'create', path: 'note.txt', content: 'probe\\n' }, rawOutput: { items: [{ Text: 'Successfully created note.txt (1 lines).' }] } });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.tool, 'write');
    // The path as the workspace sees it, not the absolute one the diff carries.
    assert.equal(activities[0]?.target, 'note.txt');

    const outputs = events.filter(
      (event): event is Extract<EngineEvent, { type: 'activity_output' }> =>
        event.type === 'activity_output',
    );

    assert.deepEqual(
      outputs.map((event) => event.output),
      ['Successfully created note.txt (1 lines).'],
    );
    // The new contents of the file are not the output of the call, and neither is
    // a second copy of the path.
    assert.ok(!outputs.some((event) => event.output.includes('/private/tmp/work')));
  });
});

test('a tool call that only reports where it worked still says so', async () => {
  // An agent that does not echo its arguments reports the file it touched instead,
  // which is the only thing left to show the call acted on something.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Edit', kind: 'edit', status: 'in_progress', locations: [{ path: '/tmp/notes.txt' }] });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(activitiesOf(events)[0]?.target, '/tmp/notes.txt');
  });
});

test('the session is reported before any answer text', async () => {
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('answer') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const session = events.findIndex((event) => event.type === 'session');
    const delta = events.findIndex((event) => event.type === 'delta');

    assert.ok(session >= 0, 'the session was never reported');
    assert.ok(session < delta, 'the session was reported after the answer had started');
    assert.equal(
      events.find((event) => event.type === 'session')?.type === 'session'
        ? (events.find((event) => event.type === 'session') as { id: string }).id
        : '',
      'sess_abc123',
    );
  });
});

/** A turn that announces a shell command and then asks about it. */
const ASK_ABOUT_SHELL = `
    global.promptId = msg.id;
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tooluse_1', title: 'Running: npm install', kind: 'execute', rawInput: { command: 'npm install' }, _meta: { kiro: { toolName: 'shell' } } });
    ask('tooluse_1', 'Running: npm install', YES_ALWAYS_NO);
`;

test('an ask names the call it is about, from what was already announced', async () => {
  await withFakeEngine('kiro-cli', conversation(ASK_ABOUT_SHELL), async () => {
    const asks: EnginePermissionRequest[] = [];

    const events = await collect(
      new KiroEngine().prompt('hi', {
        ...base,
        requestPermission: async (request) => {
          asks.push(request);
          return 'once';
        },
      }),
    );

    assert.equal(asks.length, 1);
    // The ask itself says none of this. Read alone it would reach the phone as an
    // unnamed tool acting on nothing, and no rule on this machine could match it.
    assert.equal(asks[0]?.tool, 'shell');
    assert.equal(asks[0]?.title, 'Running: npm install');
    assert.equal(asks[0]?.target, 'npm install');
    // One ask covers one call, and the option labels read as Yes, Always and No,
    // which describe nothing that would be run.
    assert.deepEqual(asks[0]?.details, []);
    // Offered because the agent itself has a lasting grant to give.
    assert.deepEqual(asks[0]?.suggestions, ['shell(npm install)']);
    assert.ok(events.some((event) => event.type === 'done'));
  });
});

test('an ask nobody can answer is refused', async () => {
  // No requestPermission means nobody is able to answer, and the alternative to
  // refusing is running a tool call nobody agreed to.
  await withFakeEngine('kiro-cli', conversation(ASK_ABOUT_SHELL), async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'chose:reject_once');
  });
});

test('a caller that throws refuses the call', async () => {
  await withFakeEngine('kiro-cli', conversation(ASK_ABOUT_SHELL), async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', {
        ...base,
        requestPermission: async () => {
          throw new Error('the browser went away');
        },
      }),
    );

    assert.equal(textOf(events), 'chose:reject_once');
  });
});

test('always allows on the wire, because the grant is kept here', async () => {
  // 'always' is recorded on this machine rather than in the agent, so it is sent
  // as an ordinary allow. See ADR-022.
  await withFakeEngine('kiro-cli', conversation(ASK_ABOUT_SHELL), async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, requestPermission: async () => 'always' }),
    );

    assert.equal(textOf(events), 'chose:allow_once');
  });
});

test('an ask about a call that was never announced is still answerable', async () => {
  // Nothing was learned about the call beforehand, so the title is all there is.
  // The ask still has to reach someone: refusing it quietly would stall the turn.
  const script = conversation(`
    global.promptId = msg.id;
    ask('tooluse_unknown', 'Running a command', YES_ALWAYS_NO);
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const asks: EnginePermissionRequest[] = [];

    await collect(
      new KiroEngine().prompt('hi', {
        ...base,
        requestPermission: async (request) => {
          asks.push(request);
          return 'reject';
        },
      }),
    );

    assert.equal(asks[0]?.tool, 'tool');
    assert.equal(asks[0]?.title, 'Running a command');
    assert.equal(asks[0]?.target, undefined);
  });
});

test('a missing login is reported as the command that fixes it', async () => {
  // How the real CLI refuses: a line on stderr, then it exits. No JSON-RPC error
  // ever arrives, so the wording is the only thing there is to read.
  const script = `#!/usr/bin/env node
process.stderr.write('error: You are not logged in, please log in with kiro-cli login\\n');
process.exit(1);
`;

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const failure = events.find((event) => event.type === 'error');

    assert.match(
      failure?.type === 'error' ? failure.message : '',
      /kiro-cli login/,
      'the refusal did not name the command that fixes it',
    );
    // The engine's own line is not relayed on top of the explanation, which would
    // report the same problem twice.
    assert.ok(!events.some((event) => event.type === 'log' && /not logged in/i.test(event.text)));
  });
});

test('an auth error mid-connection is reported the same way', async () => {
  // The other shape a missing login takes: the agent stays up and refuses the
  // session with the auth code.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: 'builder', name: 'Builder ID' }] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required' } });
    return;
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const failure = events.find((event) => event.type === 'error');

    assert.match(failure?.type === 'error' ? failure.message : '', /kiro-cli login/);
  });
});

test('a refusal to continue ends the turn as a failure', async () => {
  const script = conversation(
    `send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });`,
  );

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));

    assert.ok(events.some((event) => event.type === 'error'));
    assert.equal(
      events.find((event) => event.type === 'done')?.type === 'done'
        ? (events.find((event) => event.type === 'done') as { exitCode: number }).exitCode
        : 0,
      1,
    );
  });
});

test('a turn that ran out of tokens still keeps what it said', async () => {
  // max_tokens is not a failure: the answer is short, not absent.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('as far as I got') });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'max_tokens' } });
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));

    assert.equal(textOf(events), 'as far as I got');
    assert.ok(!events.some((event) => event.type === 'error'));
  });
});

test('a session to continue is loaded rather than started fresh', async () => {
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text(global.loaded ? 'continued' : 'fresh') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, resume: 'sess_earlier' }),
    );

    assert.equal(textOf(events), 'continued');
    // The id is the one that was asked for: loading reports no id of its own.
    assert.equal(
      events.find((event) => event.type === 'session')?.type === 'session'
        ? (events.find((event) => event.type === 'session') as { id: string }).id
        : '',
      'sess_earlier',
    );
  });
});

test('the transcript a load replays is not relayed as the new answer', async () => {
  // Loading a session replays every earlier message and tool call as ordinary
  // updates. Relaying them would repeat the whole conversation inside this answer,
  // and report work that happened in an earlier turn as work done in this one.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('the new answer') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, resume: 'sess_earlier' }),
    );

    assert.equal(textOf(events), 'the new answer');
    assert.deepEqual(activitiesOf(events), []);
  });
});

test('a chosen model is asked of the session, not left to the default', async () => {
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('model:' + String(global.model)) });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, model: 'claude-sonnet-4.5' }),
    );

    assert.equal(textOf(events), 'model:claude-sonnet-4.5');
  });
});

test('a model the agent will not take does not lose the answer', async () => {
  // The model is a preference. Failing the turn over it would throw away an answer
  // the engine was perfectly able to give on its default.
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('answered anyway') });
    ${endTurn}
  `).replace(
    "if (msg.method === 'session/set_model') {",
    `if (msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown model' } });
    return;
  }
  if (msg.method === '_never') {`,
  );

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, model: 'no-such-model' }),
    );

    assert.equal(textOf(events), 'answered anyway');
    assert.ok(!events.some((event) => event.type === 'error'));
    // Said out loud rather than swallowed: the answer came from another model than
    // the one that was asked for.
    assert.ok(events.some((event) => event.type === 'log' && /no-such-model/.test(event.text)));
  });
});

test('a stale session falls back to answering fresh', async () => {
  // Sessions live in Kiro's own store and can be pruned at any time. Answering
  // without the earlier context is better than refusing to answer.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'No such session' } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_new' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_new', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answered fresh' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', { ...base, resume: 'sess_gone' }));

    assert.equal(textOf(events), 'answered fresh');
    // The failed resume is not reported: the retry answered properly.
    assert.ok(!events.some((event) => event.type === 'error'));
    assert.equal(
      events.find((event) => event.type === 'session')?.type === 'session'
        ? (events.find((event) => event.type === 'session') as { id: string }).id
        : '',
      'sess_new',
    );
  });
});

test('a line that is not JSON does not derail the turn', async () => {
  // Some versions print their own diagnostics on stdout, which is not a protocol
  // violation worth failing a turn for.
  const script = conversation(`
    process.stdout.write('warning: something happened\\n');
    update(SESSION, { sessionUpdate: 'agent_message_chunk', content: text('still fine') });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'still fine');
  });
});

test('an agent that dies mid-turn reports it instead of hanging', async () => {
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    process.exit(1);
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));

    assert.ok(events.some((event) => event.type === 'error'));
    assert.ok(events.some((event) => event.type === 'done'));
  });
});

test('the file system and terminal capabilities are declined', async () => {
  // The agent reaches the workspace through its own tools, which is what an ask is
  // raised about. Granting these would let it read and write around that, unasked.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    const c = msg.params.clientCapabilities || {};
    const declined = c.fs && c.fs.readTextFile === false && c.fs.writeTextFile === false && c.terminal === false;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    global.declined = declined;
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: global.declined ? 'declined' : 'granted' } } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'declined');
  });
});

test('a request this adapter does not implement is refused, not ignored', async () => {
  // The capabilities above say the agent should never ask, so an ask that arrives
  // anyway is answered with an error rather than left to time out.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_1' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    global.promptId = msg.id;
    send({ jsonrpc: '2.0', id: 77, method: 'fs/read_text_file', params: { sessionId: 'sess_1', path: '/etc/passwd' } });
    return;
  }
  if (msg.error) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'refused' } } } });
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn' } });
    return;
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    assert.equal(textOf(events), 'refused');
  });
});

test('models are read from the listing as the engine writes it', async () => {
  // Recorded from `kiro-cli chat --list-models --format json`, which names the id
  // model_id and says nothing an id-shaped pattern would recognise.
  const script = `#!/usr/bin/env node
if (process.argv[2] === 'user') { console.log('Logged in with IAM Identity Center'); process.exit(0); }
console.log(JSON.stringify({
  models: [
    { model_name: 'auto', description: 'Models chosen by task', model_id: 'auto', context_window_tokens: 1000000, rate_multiplier: 1.0, rate_unit: 'Credit' },
    { model_name: 'claude-sonnet-4.5', description: 'Claude Sonnet 4.5 model', model_id: 'claude-sonnet-4.5', context_window_tokens: 200000, rate_multiplier: 1.3, rate_unit: 'Credit' },
  ],
  default_model: 'auto',
}));
`;

  await withFakeEngine('kiro-cli', script, async () => {
    // 'auto' is the default the engine ships with, so a listing that dropped it
    // would hide the only model most conversations would use.
    assert.deepEqual(await new KiroEngine().listModels(), ['auto', 'claude-sonnet-4.5']);
  });
});

test('models are also read from the plain format', async () => {
  // The fallback for a version whose --format is missing or spelled differently,
  // recorded from `--format plain`. The heading is a line of words like any other,
  // so model lines are recognised by the credit column instead.
  const script = `#!/usr/bin/env node
if (process.argv[2] === 'user') { console.log('Logged in with IAM Identity Center'); process.exit(0); }
console.log('Available models (* = default):');
console.log('');
console.log('* auto                 1.00x credits      Models chosen by task');
console.log('  claude-sonnet-4.5    1.30x credits      Claude Sonnet 4.5 model');
console.log('  glm-5                0.50x credits      GLM-5 model');
`;

  await withFakeEngine('kiro-cli', script, async () => {
    assert.deepEqual(await new KiroEngine().listModels(), ['auto', 'claude-sonnet-4.5', 'glm-5']);
  });
});

test('a login that blocks the model list is not a missing engine', async () => {
  // An engine with no login still has an executable, and reporting no models is
  // read as "use the engine default" rather than as an engine that cannot run.
  const script = `#!/usr/bin/env node
process.stderr.write('Not logged in\\n');
process.exit(1);
`;

  await withFakeEngine('kiro-cli', script, async () => {
    const engine = new KiroEngine();

    assert.equal(await engine.isAvailable(), true);
    assert.deepEqual(await engine.listModels(), []);
  });
});

test('the model list is never asked for when nobody is logged in', async () => {
  // Recorded from the real CLI: listing models without a login does not fail, it
  // opens a browser and waits for a device login to be completed. Discovery runs at
  // startup, so asking anyway would hand a login page to someone who only opened
  // the menu, and hold startup until they dealt with it.
  const marker = join(await mkdtemp(join(tmpdir(), 'kiro-marker-')), 'asked');

  const script = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv[2] === 'user') {
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));
process.exit(0);
`;

  await withFakeEngine('kiro-cli', script, async () => {
    assert.deepEqual(await new KiroEngine().listModels(), []);
    assert.equal(existsSync(marker), false, 'the model list was asked for without a login');
  });
});

test('a missing engine reports unavailable instead of throwing', async () => {
  await withEmptyPath(async () => {
    const engine = new KiroEngine();

    assert.equal(await engine.isAvailable(), false);
    assert.deepEqual(await engine.listModels(), []);
  });
});

test('a refused call is not explained in the engine words as well', async () => {
  // Recorded from a rejected ask: the agent fails the call and words it as the user
  // having denied it. The refusal is reported a level up, where the reason is
  // actually known, and a limit on this machine refuses without anyone being asked.
  const script = conversation(`
    global.promptId = msg.id;
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tooluse_1', title: 'Running: echo probe', kind: 'execute', rawInput: { command: 'echo probe' }, _meta: { kiro: { toolName: 'shell' } } });
    ask('tooluse_1', 'Running: echo probe', YES_ALWAYS_NO);
  `).replace(
    'const outcome = msg.result.outcome;',
    `const outcome = msg.result.outcome;
    update(SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'tooluse_1', kind: 'execute', status: 'failed', title: 'shell', content: [{ type: 'content', content: text('User denied tool execution') }], rawInput: { command: 'echo probe' }, _meta: { kiro: { toolName: 'shell' } } });`,
  );

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(
      new KiroEngine().prompt('hi', { ...base, requestPermission: async () => 'reject' }),
    );

    // The call itself is still reported, so the answer that follows has a cause.
    assert.equal(activitiesOf(events)[0]?.tool, 'shell');
    assert.deepEqual(
      events.filter((event) => event.type === 'activity_output'),
      [],
    );
  });
});

test('a call that failed on its own still reports that it failed', async () => {
  const script = conversation(`
    update(SESSION, { sessionUpdate: 'tool_call', toolCallId: 'tooluse_1', title: 'Running: nope', kind: 'execute', rawInput: { command: 'nope' }, _meta: { kiro: { toolName: 'shell' } } });
    update(SESSION, { sessionUpdate: 'tool_call_update', toolCallId: 'tooluse_1', status: 'failed' });
    ${endTurn}
  `);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const output = events.find((event) => event.type === 'activity_output');

    assert.equal(output?.type === 'activity_output' ? output.output : '', 'The tool call failed.');
  });
});

test('a failure that is not about a login is reported in its own words', async () => {
  // -32000 is the range JSON-RPC leaves to an implementation, so it is the code an
  // agent reaches for whenever something went wrong on its side. Read as a missing
  // login, a quota problem would send the user to kiro-cli login over and over to
  // fix something a login cannot fix.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Monthly request limit reached' } });
    return;
  }
}
`);

  await withFakeEngine('kiro-cli', script, async () => {
    const events = await collect(new KiroEngine().prompt('hi', base));
    const failure = events.find((event) => event.type === 'error');
    const message = failure?.type === 'error' ? failure.message : '';

    assert.match(message, /Monthly request limit reached/);
    assert.doesNotMatch(message, /kiro-cli login/);
  });
});
