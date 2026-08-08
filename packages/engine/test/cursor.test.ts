import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorEngine } from '../dist/adapters/cursor.js';
import { createEngine, discoverEngines, ENGINE_NAMES } from '../dist/registry.js';
import type { EngineEvent, EnginePermissionRequest, PromptOptions } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fakes built from traffic recorded from Cursor Agent CLI 2026.08.04-aaa8809 over
 * the hidden `agent acp` subcommand.
 *
 * The shapes here are the ones the real agent sent, which is why they are narrower
 * and odder than the protocol allows: an option id is spelled with hyphens where
 * its kind uses underscores, a tool call id contains a literal newline, a shell
 * call reports itself only through `rawOutput` as `{exitCode, stdout, stderr}`, a
 * pruned session is an ordinary `-32602` that names the session only in
 * `data.message`, the models are reported by the session rather than by a listing
 * command, and nothing anywhere reports a token count.
 *
 * The framing is one JSON object per line, which is what ACP uses over stdio.
 */

/**
 * Builds a fake agent from a script fragment.
 *
 * The fragment is a body with `send(obj)` for writing a line and `handle(msg)`
 * called for every line the adapter writes. The boilerplate is shared because a
 * fake that cannot answer initialize never reaches the part a test is about.
 *
 * `agent status` is answered before stdin is read at all, because the adapter runs
 * it as its login check and it never speaks the protocol.
 */
function agent(body: string): string {
  return `#!/usr/bin/env node
const ARGS = process.argv.slice(2);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

if (ARGS[0] === 'status') {
  process.stdout.write('Logged in as recorded@example.com\\n');
  process.exit(0);
}

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

/** The exact tool call id the real agent sent, newline and all. */
const RECORDED_CALL_ID =
  'call-0f46d617-9c45-475f-a3e1-8d785cc86c75-0\nfc_87d7cc5d-289a-91a9-a1c8-27b892632a6e_0';

/** The models the real session reports, trimmed to the ends of the list. */
const MODELS = `{ currentModelId: 'default[]', availableModels: [{ modelId: 'default[]', name: 'Auto' }, { modelId: 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]', name: 'claude-opus-5' }, { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }] }`;

/** The modes the real session reports, already in the one that can do the work. */
const MODES = `{ currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }] }`;

/** Answers the handshake and the session, then runs a test's own turn body. */
function conversation(
  turn: string,
  options: { sessionId?: string; modes?: string; extra?: string } = {},
): string {
  const sessionId = options.sessionId ?? '0af49aa5-41f8-42c4-ac51-95f4955d5a57';

  return agent(`
const SESSION = ${JSON.stringify(sessionId)};
const CALL_ID = ${JSON.stringify(RECORDED_CALL_ID)};
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u } });
const text = (t) => ({ type: 'text', text: t });
const done = () => send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn' } });

/**
 * Asks about a tool call the way the real agent does: the ask carries the whole
 * call, and its reason arrives as a content entry.
 */
const ask = (toolCall, options) =>
  send({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: { sessionId: SESSION, toolCall, options } });

/**
 * The three answers the agent offers. The ids are hyphenated where the kinds are
 * not, which is why nothing may guess an id from a kind.
 */
const ALLOW_ALWAYS_REJECT = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function handle(msg) {
  // The answer to an ask, which is a result carrying an outcome. What was chosen is
  // said out loud so a test can read the decision that reached the agent.
  if (msg.result && msg.result.outcome) {
    const outcome = msg.result.outcome;
    global.chose = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    ${turn.includes('AFTER_ASK') ? '' : "update({ sessionUpdate: 'agent_message_chunk', content: text('chose:' + global.chose) }); done();"}
    ${turn.includes('AFTER_ASK') ? 'afterAsk();' : ''}
    return;
  }
  if (msg.method === 'initialize') {
    global.handshake = msg.params;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {} } }, authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }] } });
    return;
  }
  if (msg.method === 'session/new') {
    global.newParams = msg.params;
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION, modes: ${options.modes ?? MODES}, models: ${MODELS}, configOptions: [] } });
    return;
  }
  // A pruned conversation is an ordinary Invalid params that names the session only
  // in its data payload.
  if (msg.method === 'session/load') {
    global.loadParams = msg.params;
    if (msg.params.sessionId !== SESSION) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params', data: { message: 'Session "' + msg.params.sessionId + '" not found' } } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: ${options.modes ?? MODES}, models: ${MODELS}, configOptions: [] } });
    return;
  }
  if (msg.method === 'session/set_mode') {
    global.mode = msg.params.modeId;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/set_model') {
    if (msg.params.modelId === 'not-a-model') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: "Unknown model 'not-a-model'." } });
      return;
    }
    global.model = msg.params.modelId;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    global.promptId = msg.id;
    global.promptParams = msg.params;
    ${turn}
    return;
  }
  if (msg.method === 'session/cancel') {
    global.cancelled = true;
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'cancelled' } });
    return;
  }
}
${options.extra ?? ''}
`);
}

/** Drains a turn into an array, so a test can assert over the whole of it. */
async function collect(
  engine: CursorEngine,
  text: string,
  options: Partial<PromptOptions> = {},
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];

  for await (const event of engine.prompt(text, { cwd: process.cwd(), ...options })) {
    events.push(event);
  }

  return events;
}

const deltas = (events: EngineEvent[]): string =>
  events
    .filter((event): event is Extract<EngineEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');

const only = <T extends EngineEvent['type']>(
  events: EngineEvent[],
  type: T,
): Extract<EngineEvent, { type: T }>[] =>
  events.filter((event): event is Extract<EngineEvent, { type: T }> => event.type === type);

test('reports its own name and the executable it drives', () => {
  const engine = new CursorEngine();
  assert.equal(engine.name, 'cursor');
  assert.equal(engine.command, 'agent');
});

test('is registered last, leaving every earlier position unchanged', () => {
  assert.deepEqual(
    [...ENGINE_NAMES],
    ['opencode', 'claude', 'antigravity', 'kiro', 'codex', 'copilot', 'cursor'],
  );

  const engine = createEngine('cursor');
  assert.equal(engine?.name, 'cursor');
  assert.equal(engine?.command, 'agent');
});

test('is not offered on a machine without the executable', async () => {
  await withEmptyPath(async () => {
    assert.equal(await new CursorEngine().isAvailable(), false);

    const found = await discoverEngines();
    assert.equal(
      found.some((entry) => entry.name === 'cursor'),
      false,
    );
  });
});

/**
 * The pinning test.
 *
 * `acp` is hidden and undocumented, so nothing but this says the adapter still
 * asks for the surface that can raise a permission ask. A Cursor release that
 * renames it, or a change here that adds `--force`, has to fail loudly rather
 * than quietly turning every ask into something nobody was asked about.
 */
test('drives the hidden acp subcommand and nothing else', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('args:' + JSON.stringify(ARGS)) });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    assert.equal(deltas(events), 'args:["acp"]');
  });
});

test('declines the file system and terminal capabilities in the handshake', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text(JSON.stringify(global.handshake)) });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    const handshake = JSON.parse(deltas(events)) as {
      protocolVersion: number;
      clientCapabilities: {
        fs: { readTextFile: boolean; writeTextFile: boolean };
        terminal: boolean;
      };
    };

    assert.equal(handshake.protocolVersion, 1);
    assert.deepEqual(handshake.clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });
});

test('opens the session in the working directory with no MCP servers', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text(JSON.stringify(global.newParams)) });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', { cwd: process.cwd() });
    assert.deepEqual(JSON.parse(deltas(events)), { cwd: process.cwd(), mcpServers: [] });
  });
});

test('carries the prompt text through unchanged', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text(JSON.stringify(global.promptParams.prompt)) });
    done();
  `);

  const awkward = 'line one\nline two\t"quoted" {"json":true} — ünïcode';

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), awkward);
    assert.deepEqual(JSON.parse(deltas(events)), [{ type: 'text', text: awkward }]);
  });
});

test('reports the conversation id before the answer', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('hi') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    const session = events.findIndex((event) => event.type === 'session');
    const delta = events.findIndex((event) => event.type === 'delta');

    assert.ok(session >= 0);
    assert.ok(session < delta);
    assert.equal(only(events, 'session')[0]?.id, '0af49aa5-41f8-42c4-ac51-95f4955d5a57');
  });
});

test('keeps thinking beside the answer rather than inside it', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_thought_chunk', content: text('Running ') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('The output ') });
    update({ sessionUpdate: 'agent_thought_chunk', content: text('the command.') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('is hello.') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.equal(deltas(events), 'The output is hello.');
    assert.equal(
      only(events, 'reasoning')
        .map((event) => event.text)
        .join(''),
      'Running the command.',
    );
  });
});

test('ignores the conversation title and the slash commands it offers', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'session_info_update', title: 'Shell Command Echo' });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'simplify' }] });
    update({ sessionUpdate: 'user_message_chunk', content: text('the question again') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('only this') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.equal(deltas(events), 'only this');
    assert.deepEqual(only(events, 'activity'), []);
    assert.deepEqual(only(events, 'activity_output'), []);
  });
});

/**
 * The allowed ask, end to end, as it was recorded: the call is announced pending,
 * the ask names why, the answer lets it run, and the shell result comes back only
 * through rawOutput.
 */
test('an allowed ask runs the call and reports what it produced', async () => {
  const script = conversation(
    `
    update({ sessionUpdate: 'tool_call', toolCallId: CALL_ID, title: '\\\`echo hello-from-acp\\\`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hello-from-acp' } });
    ask({ toolCallId: CALL_ID, title: '\\\`echo hello-from-acp\\\`', kind: 'execute', status: 'pending', content: [{ type: 'content', content: text('Not in allowlist: echo') }] }, ALLOW_ALWAYS_REJECT);
    global.AFTER_ASK = 1;
  `,
    {
      extra: `
function afterAsk() {
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'in_progress' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'completed', rawOutput: { exitCode: 0, stdout: 'hello-from-acp\\n', stderr: '' } });
  update({ sessionUpdate: 'agent_message_chunk', content: text('chose:' + global.chose) });
  done();
}
`,
    },
  );

  await withFakeEngine('agent', script, async () => {
    const asks: EnginePermissionRequest[] = [];
    const events = await collect(new CursorEngine(), 'run echo', {
      requestPermission: async (request) => {
        asks.push(request);
        return 'once';
      },
    });

    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.tool, 'execute');
    assert.equal(asks[0]?.target, 'echo hello-from-acp');
    assert.equal(asks[0]?.reason, 'Not in allowlist: echo');
    assert.deepEqual(asks[0]?.suggestions, ['execute(echo hello-from-acp)']);

    // Allowed once on the wire, so the id sent back is the allow-once one.
    assert.equal(deltas(events), 'chose:allow-once');

    const activities = only(events, 'activity');
    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.id, RECORDED_CALL_ID);
    assert.equal(activities[0]?.tool, 'execute');

    const outputs = only(events, 'activity_output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0]?.output, 'hello-from-acp');

    // Nothing on this surface reports token counts, so nothing may be invented.
    assert.deepEqual(only(events, 'usage'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

/**
 * Always allow is recorded on this machine, so it is answered on the wire exactly
 * as once is and Cursor's own lasting grant is never taken up. See ADR-022.
 */
test('always allow never sends Cursor its own lasting grant', async () => {
  const script = conversation(`
    ask({ toolCallId: CALL_ID, title: 'shell', kind: 'execute', status: 'pending' }, ALLOW_ALWAYS_REJECT);
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'run echo', {
      requestPermission: async () => 'always',
    });

    assert.equal(deltas(events), 'chose:allow-once');
  });
});

test('a refused ask is described once and the turn carries on', async () => {
  const script = conversation(
    `
    update({ sessionUpdate: 'tool_call', toolCallId: CALL_ID, kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf /tmp/nope' } });
    ask({ toolCallId: CALL_ID, kind: 'execute', status: 'pending' }, ALLOW_ALWAYS_REJECT);
    global.AFTER_ASK = 1;
  `,
    {
      extra: `
function afterAsk() {
  // What the real agent does after a refusal: it fails the call with a notice of
  // its own, worded as the user having denied it.
  update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'failed', content: [{ type: 'content', content: text('The user denied permission to run this command.') }] });
  update({ sessionUpdate: 'agent_message_chunk', content: text('chose:' + global.chose) });
  done();
}
`,
    },
  );

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'delete it', {
      requestPermission: async () => 'reject',
    });

    assert.equal(deltas(events), 'chose:reject-once');

    // The refusal is reported by the layer that knows whether a person, a stored
    // rule, or nobody at all decided it, so Cursor's own notice is not relayed.
    assert.deepEqual(only(events, 'activity_output'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('an ask nobody can answer is refused', async () => {
  const script = conversation(`
    ask({ toolCallId: CALL_ID, kind: 'execute', status: 'pending' }, ALLOW_ALWAYS_REJECT);
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'run it');
    assert.equal(deltas(events), 'chose:reject-once');
  });
});

test('an ask whose answer throws is refused', async () => {
  const script = conversation(`
    ask({ toolCallId: CALL_ID, kind: 'execute', status: 'pending' }, ALLOW_ALWAYS_REJECT);
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'run it', {
      requestPermission: async () => {
        throw new Error('the phone went away');
      },
    });

    assert.equal(deltas(events), 'chose:reject-once');
  });
});

test('an ask offering nothing that carries the decision is cancelled', async () => {
  const script = conversation(`
    ask({ toolCallId: CALL_ID, kind: 'execute', status: 'pending' }, [{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }]);
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'run it', {
      requestPermission: async () => 'once',
    });

    // allow_always is the only thing offered and may never be sent, so the only
    // remaining honest answer is the cancelled outcome.
    assert.equal(deltas(events), 'chose:cancelled');
  });
});

test('a tool call that failed with no output still says so', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/a.txt' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'edit it');

    assert.deepEqual(only(events, 'activity'), [
      { type: 'activity', id: 'call-1', tool: 'edit', target: '/tmp/a.txt' },
    ]);
    assert.deepEqual(only(events, 'activity_output'), [
      { type: 'activity_output', id: 'call-1', output: 'The tool call failed.' },
    ]);
  });
});

test('a newline in a tool call id describes one call and never reaches prose', async () => {
  const script = conversation(
    `
    update({ sessionUpdate: 'tool_call', toolCallId: CALL_ID, kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: CALL_ID, status: 'completed', rawOutput: { exitCode: 0, stdout: 'hi\\n', stderr: '' } });
    done();
  `,
  );

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'run it');

    // One call, not two: the id is correlated exactly as it arrived.
    assert.equal(only(events, 'activity').length, 1);
    assert.equal(only(events, 'activity')[0]?.id, RECORDED_CALL_ID);
    assert.equal(only(events, 'activity_output').length, 1);
    assert.equal(only(events, 'activity_output')[0]?.id, RECORDED_CALL_ID);

    // No message written for a person carries the raw id, so none of them can be
    // broken in half by the newline inside it.
    for (const event of events) {
      if (event.type === 'delta' || event.type === 'reasoning' || event.type === 'log') {
        assert.equal(event.text.includes(RECORDED_CALL_ID), false);
      }
    }
  });
});

test('a pruned conversation costs the context, not the answer', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered fresh') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', { resume: 'long-gone' });

    assert.equal(deltas(events), 'answered fresh');

    // The new conversation's id is reported, so the stored one is replaced.
    assert.deepEqual(
      only(events, 'session').map((event) => event.id),
      ['0af49aa5-41f8-42c4-ac51-95f4955d5a57'],
    );

    // The abandoned attempt contributes nothing: it was not a failure worth
    // reporting when the retry answered properly.
    assert.deepEqual(only(events, 'error'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('a load failure that is not a pruned conversation is reported', async () => {
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params', data: { message: 'cwd must be an absolute path' } } });
    return;
  }
  // Reached only if the adapter wrongly retried on a new conversation.
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'must-not-happen' } });
    return;
  }
}
`);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', { resume: 'some-session' });

    assert.deepEqual(
      only(events, 'error').map((event) => event.message),
      ['Invalid params'],
    );
    assert.deepEqual(only(events, 'session'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 1 }]);
  });
});

test('resuming a conversation Cursor still holds keeps it', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('carried on') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', {
      resume: '0af49aa5-41f8-42c4-ac51-95f4955d5a57',
    });

    assert.equal(deltas(events), 'carried on');
    assert.deepEqual(
      only(events, 'session').map((event) => event.id),
      ['0af49aa5-41f8-42c4-ac51-95f4955d5a57'],
    );
  });
});

test('a resumed conversation is not answered with the one Cursor replays', async () => {
  // Recorded shape: a load resends every earlier turn as notifications before it
  // answers, and numbers the calls it replays from zero on each load, so the same
  // `replay-0-1` arrives again on the next resume of the same conversation.
  const script = agent(`
const SESSION = '0af49aa5-41f8-42c4-ac51-95f4955d5a57';
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u } });
const text = (t) => ({ type: 'text', text: t });

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    return;
  }
  if (msg.method === 'session/load') {
    update({ sessionUpdate: 'user_message_chunk', content: text('what is the package name') });
    update({ sessionUpdate: 'agent_thought_chunk', content: text('thinking from last time') });
    update({ sessionUpdate: 'tool_call', toolCallId: 'replay-0-1', status: 'completed', kind: 'read', title: 'Read package.json', rawInput: { path: 'package.json' } });
    update({ sessionUpdate: 'agent_message_chunk', content: text('the answer from last time') });
    send({ jsonrpc: '2.0', id: msg.id, result: { modes: ${MODES}, models: ${MODELS} } });
    return;
  }
  if (msg.method === 'session/prompt') {
    update({ sessionUpdate: 'agent_message_chunk', content: text('the answer to this prompt') });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
}
`);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'and now?', {
      resume: '0af49aa5-41f8-42c4-ac51-95f4955d5a57',
    });

    // This turn's answer, with none of the conversation read back before it.
    assert.equal(deltas(events), 'the answer to this prompt');
    assert.deepEqual(only(events, 'reasoning'), []);
    assert.deepEqual(only(events, 'activity'), []);
    assert.deepEqual(only(events, 'activity_output'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('leaves the mode alone when the session is already in agent', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('mode:' + String(global.mode)) });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    assert.equal(deltas(events), 'mode:undefined');
  });
});

test('corrects a read-only mode before prompting', async () => {
  const script = conversation(
    `
    update({ sessionUpdate: 'agent_message_chunk', content: text('mode:' + String(global.mode)) });
    done();
  `,
    {
      modes: `{ currentModeId: 'plan', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }] }`,
    },
  );

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    assert.equal(deltas(events), 'mode:agent');
  });
});

test('applies a chosen model to the open conversation, brackets intact', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('model:' + String(global.model)) });
    done();
  `);

  const model = 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]';

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', { model });
    assert.equal(deltas(events), `model:${model}`);
  });
});

test('a refused model answers on the default and says so', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered anyway') });
    done();
  `);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello', { model: 'not-a-model' });

    assert.equal(deltas(events), 'answered anyway');
    assert.equal(
      only(events, 'log').some((event) => event.text.includes('not-a-model')),
      true,
    );
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('offers the models the session reported and never asks for a listing', async () => {
  const script = conversation(`done();`);

  await withFakeEngine('agent', script, async () => {
    const models = await new CursorEngine().listModels();

    // The id keeps its bracketed parameters because `session/set_model` accepts
    // nothing shorter — `claude-opus-5` alone comes back as `Invalid model value` —
    // and the name travels beside it as the label. `default[]` is the case that
    // makes the pair necessary: it is what the engine takes back, and `Auto` is what
    // it means. See ADR-051.
    assert.deepEqual(models, [
      { id: 'default[]', label: 'Auto' },
      {
        id: 'claude-opus-5[thinking=true,context=300k,effort=high,fast=false]',
        label: 'claude-opus-5',
      },
      { id: 'composer-2.5[fast=true]', label: 'composer-2.5' },
    ]);
  });
});

test('offers no models on a machine nobody has logged into', async () => {
  // Exits nonzero for `status`, which is the whole of the login answer, and never
  // reaches the protocol.
  const script = `#!/usr/bin/env node
if (process.argv[2] === 'status') {
  process.stderr.write('Not logged in. Run agent login to authenticate.\\n');
  process.exit(1);
}
process.stderr.write('Not logged in. Run agent login to authenticate.\\n');
process.exit(1);
`;

  await withFakeEngine('agent', script, async () => {
    assert.deepEqual(await new CursorEngine().listModels(), []);

    const events = await collect(new CursorEngine(), 'hello');
    assert.deepEqual(
      only(events, 'error').map((event) => event.message),
      ['Cursor is not logged in. Run agent login on this machine, then try again.'],
    );
    // The recognised line is not relayed beside the message that names its remedy.
    assert.deepEqual(only(events, 'log'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 1 }]);
  });
});

test('a refusal to continue is an error, and a stop is not', async () => {
  const refusing = conversation(`
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
  `);

  await withFakeEngine('agent', refusing, async () => {
    const events = await collect(new CursorEngine(), 'hello');
    assert.equal(only(events, 'error').length, 1);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 1 }]);
  });

  const stopping = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('starting') });
  `);

  await withFakeEngine('agent', stopping, async () => {
    const controller = new AbortController();
    const engine = new CursorEngine();
    const events: EngineEvent[] = [];

    for await (const event of engine.prompt('hello', {
      cwd: process.cwd(),
      signal: controller.signal,
    })) {
      events.push(event);

      if (event.type === 'delta') {
        controller.abort();
      }
    }

    assert.deepEqual(only(events, 'error'), []);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('an agent that exits mid-turn ends the turn rather than hanging', async () => {
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'gone-soon' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    process.exit(3);
  }
}
`);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.equal(only(events, 'error').length, 1);
    assert.equal(only(events, 'done').length, 1);
    assert.equal(events.at(-1)?.type, 'done');
  });
});

test('a session with no id is reported rather than prompted into', async () => {
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: '' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    global.prompted = true;
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
}
`);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.deepEqual(
      only(events, 'error').map((event) => event.message),
      ['Cursor started a session with no id.'],
    );
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 1 }]);
  });
});

/**
 * The file system and terminal capabilities are declined in the handshake, so an
 * agent that asks for them anyway is refused by name rather than served. The turn
 * has to survive that: an answer built without a capability is better than a turn
 * that dies over one.
 */
test('a request this adapter does not implement is refused by name', async () => {
  const script = agent(`
const send2 = send;
function handle(msg) {
  // The refusal coming back for the request below. Its message is relayed as the
  // answer so a test can read what the agent was told.
  if (msg.id === 99 && msg.error) {
    send2({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'S', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'refused:' + msg.error.message } } } });
    send2({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.method === 'initialize') {
    send2({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'session/new') {
    send2({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'S' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    global.promptId = msg.id;
    send2({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
    return;
  }
}
`);

  await withFakeEngine('agent', script, async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.equal(deltas(events), 'refused:Unsupported request: fs/read_text_file');
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 0 }]);
  });
});

test('a missing executable is reported as a command that could not be found', async () => {
  await withEmptyPath(async () => {
    const events = await collect(new CursorEngine(), 'hello');

    assert.equal(only(events, 'error').length, 1);
    assert.deepEqual(only(events, 'done'), [{ type: 'done', exitCode: 127 }]);
  });
});

test('a consumer that stops reading early leaves nothing running', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('first') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('second') });
  `);

  await withFakeEngine('agent', script, async () => {
    const engine = new CursorEngine();

    for await (const event of engine.prompt('hello', { cwd: process.cwd() })) {
      if (event.type === 'delta') {
        break;
      }
    }

    // Reaching here at all is the assertion: the generator's finally closed the
    // connection, so nothing is waiting on a process with workspace access.
    assert.ok(true);
  });
});
