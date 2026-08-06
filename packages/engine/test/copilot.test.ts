import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotEngine } from '../dist/adapters/copilot.js';
import type { EngineEvent, EnginePermissionRequest, PromptOptions } from '../dist/types.js';
import { withFakeEngine } from './helpers.ts';

/**
 * Fakes built from traffic recorded from GitHub Copilot CLI 1.0.78 over
 * `copilot --acp`.
 *
 * The shapes here are the ones the real agent sent, which is why they are narrower
 * than the protocol allows: a tool call carries no name of its own beyond the ACP
 * kind, its content arrives as an array, its own result is a plain string, an ask
 * carries the whole tool call rather than a reference to one, and the models are
 * reported by the session rather than by a listing command.
 *
 * The framing is one JSON object per line, which is what ACP uses over stdio.
 */

/**
 * Builds a fake agent from a script fragment.
 *
 * The fragment is a body with `send(obj)` for writing a line and `handle(msg)`
 * called for every line the adapter writes. The boilerplate is shared because a
 * fake that cannot answer initialize never reaches the part a test is about.
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

/** The models the real session reports, trimmed to the ends of the list. */
const MODELS = `{ currentModelId: 'claude-sonnet-5', availableModels: [{ modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' }, { modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, { modelId: 'gpt-5.4-mini', name: 'GPT-5.4 mini' }] }`;

/** Answers the handshake and the session, then runs a test's own turn body. */
function conversation(turn: string, options: { sessionId?: string } = {}): string {
  const sessionId = options.sessionId ?? '39095fff-8c9e-4f43-a486-37b089a0250c';

  return agent(`
const SESSION = ${JSON.stringify(sessionId)};
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update: u } });
const text = (t) => ({ type: 'text', text: t });

/**
 * Asks about a tool call the way the real agent does: the ask carries the whole
 * call, including the arguments it was announced with.
 */
const ask = (toolCall, options) =>
  send({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: { sessionId: SESSION, toolCall, options } });

/** The three answers the agent offers, worded as it words them. */
const ALLOW_ALWAYS_DENY = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
];

function handle(msg) {
  // The answer to an ask, which is a result carrying an outcome. What was chosen is
  // said out loud so a test can read the decision that reached the agent.
  if (msg.result && msg.result.outcome) {
    const outcome = msg.result.outcome;
    update({ sessionUpdate: 'agent_message_chunk', content: text(outcome.outcome === 'selected' ? 'chose:' + outcome.optionId : 'cancelled') });
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.78' }, authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION, models: ${MODELS}, modes: { currentModeId: 'agent', availableModes: [] }, configOptions: [] } });
    return;
  }
  // Loading replays the whole transcript before it answers, and its result carries
  // no session id: the session loaded is the one that was asked for.
  if (msg.method === 'session/load') {
    if (msg.params.sessionId !== SESSION) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Resource not found: Session ' + msg.params.sessionId + ' not found', data: { uri: 'Session not found' } } });
      return;
    }
    global.loaded = true;
    update({ sessionUpdate: 'user_message_chunk', content: text('an earlier question') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('an earlier answer') });
    send({ jsonrpc: '2.0', id: msg.id, result: { models: ${MODELS}, modes: { currentModeId: 'agent', availableModes: [] }, configOptions: [] } });
    return;
  }
  if (msg.method === 'session/set_model') {
    if (msg.params.modelId === 'not-a-model') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: "Invalid model 'not-a-model'. Supported values: auto, claude-sonnet-5." } });
      return;
    }
    global.model = msg.params.modelId;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'session/prompt') {
    global.promptId = msg.id;
    ${turn}
    return;
  }
  if (msg.method === 'session/cancel') {
    global.cancelled = true;
    send({ jsonrpc: '2.0', id: global.promptId, result: { stopReason: 'cancelled' } });
    return;
  }
}
`);
}

/** Ends a turn the way the real agent does, reporting its usage with the result. */
const endTurn = `send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 48710, outputTokens: 103, totalTokens: 48813, thoughtTokens: 0, cachedReadTokens: 41249, cachedWriteTokens: 7457 } } });`;

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

type Activity = Extract<EngineEvent, { type: 'activity' }>;

function activitiesOf(events: EngineEvent[]): Activity[] {
  return events.filter((event): event is Activity => event.type === 'activity');
}

function outputsOf(events: EngineEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<EngineEvent, { type: 'activity_output' }> =>
        event.type === 'activity_output',
    )
    .map((event) => event.output);
}

const base: PromptOptions = { cwd: process.cwd() };

test('an answer is assembled from the message chunks', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('h') });
    update({ sessionUpdate: 'agent_message_chunk', content: text('ello') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(textOf(events), 'hello');
    assert.deepEqual(
      events.at(-1),
      { type: 'done', exitCode: 0 },
      'a turn that ended normally reports a clean exit',
    );
  });
});

test('the session id is reported before the answer, so a cut run can be continued', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    const session = events.findIndex((event) => event.type === 'session');
    const delta = events.findIndex((event) => event.type === 'delta');

    assert.notEqual(session, -1);
    assert.ok(session < delta, 'the id has to arrive before anything can be cut short');
  });
});

test('token usage is read from the result the prompt returns', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('done') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.deepEqual(
      events.find((event) => event.type === 'usage'),
      { type: 'usage', inputTokens: 48710, outputTokens: 103 },
    );
  });
});

test('the context window notice is not reported as token usage', async () => {
  // usage_update says how full the context window is, which is not what a turn
  // cost. Read as usage it would bill the whole conversation to every turn.
  const script = conversation(`
    update({ sessionUpdate: 'usage_update', used: 18415, size: 200000 });
    update({ sessionUpdate: 'agent_message_chunk', content: text('hi') });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(
      events.find((event) => event.type === 'usage'),
      undefined,
    );
    assert.equal(textOf(events), 'hi');
  });
});

test('the commands and settings a session announces are not part of the answer', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Summarize conversation history' }] });
    update({ sessionUpdate: 'config_option_update', configOptions: [{ type: 'select', id: 'model', name: 'Model', currentValue: 'claude-sonnet-5', options: [] }] });
    update({ sessionUpdate: 'agent_message_chunk', content: text('only this') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(textOf(events), 'only this');
    assert.deepEqual(activitiesOf(events), []);
  });
});

test('a shell call is named by its kind and reports the command it ran', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_01', title: 'Display contents of sample.txt', kind: 'execute', status: 'pending', rawInput: { command: 'cat sample.txt', description: 'Display contents of sample.txt' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed', content: [{ type: 'content', content: text('hello world\\n<shellId: 0 completed with exit code 0>') }], rawOutput: { content: 'hello world\\n<shellId: 0 completed with exit code 0>', detailedContent: 'hello world', contents: [{ type: 'shell_exit', shellId: '0', exitCode: 0 }] } });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities.length, 1);
    // The kind is the only name the agent gives the tool, and the command is what a
    // permission rule on this machine is judged against.
    assert.equal(activities[0]?.tool, 'execute');
    assert.equal(activities[0]?.target, 'cat sample.txt');
    assert.deepEqual(outputsOf(events), ['hello world\n<shellId: 0 completed with exit code 0>']);
  });
});

test('a running shell that repeats its output is reported once per change', async () => {
  // A shell still running is reported again on every update, carrying what it has
  // produced so far. Each one is stored as the call's output, so relaying the
  // unchanged repeats writes the same value over itself.
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_13', title: 'Echo', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_13', content: [{ type: 'content', content: text('hi\\n') }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_13', content: [{ type: 'content', content: text('hi\\n') }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_13', status: 'completed', content: [{ type: 'content', content: text('hi\\n<shellId: 0 completed with exit code 0>') }] });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.deepEqual(outputsOf(events), ['hi\n', 'hi\n<shellId: 0 completed with exit code 0>']);
    // Announced once, even though it was reported four times.
    assert.equal(activitiesOf(events).length, 1);
  });
});

test('a file call reports the path it acted on', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_02', title: 'Viewing ...ws/sample.txt', kind: 'read', status: 'pending', rawInput: { path: '/ws/sample.txt' }, locations: [{ path: '/ws/sample.txt' }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_02', status: 'completed', rawOutput: { content: 'hello world\\n', detailedContent: 'diff --git a/ws/sample.txt b/ws/sample.txt' } });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities[0]?.tool, 'read');
    assert.equal(activities[0]?.target, '/ws/sample.txt');
    // The plain result is read, not the diff beside it: a diff carries the whole
    // file body and a second copy of the path.
    assert.deepEqual(outputsOf(events), ['hello world\n']);
  });
});

test('a written file is reported without its diff, which is the whole new contents', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_03', title: 'Creating ...ws/note.txt', kind: 'edit', status: 'pending', rawInput: { path: '/ws/note.txt', file_text: 'done' }, locations: [{ path: '/ws/note.txt' }], content: [{ type: 'diff', path: '/ws/note.txt', oldText: '', newText: 'done' }] });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_03', status: 'completed', content: [{ type: 'diff', path: '/ws/note.txt', oldText: '', newText: 'done' }], rawOutput: { content: 'Created file /ws/note.txt with 4 characters' } });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(activitiesOf(events)[0]?.tool, 'edit');
    assert.equal(activitiesOf(events)[0]?.target, '/ws/note.txt');
    assert.deepEqual(outputsOf(events), ['Created file /ws/note.txt with 4 characters']);
  });
});

test('a call is not reported while it is still pending, since nobody has allowed it', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_04', title: 'Running something', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.deepEqual(activitiesOf(events), []);
  });
});

test('an ask names the tool, the command, and every command inside it', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_05', title: 'Display contents of sample.txt', kind: 'execute', status: 'pending', rawInput: { command: 'cat sample.txt', description: 'Display contents of sample.txt' } });
    ask({ toolCallId: 'toolu_05', title: 'Display contents of sample.txt', kind: 'execute', status: 'pending', rawInput: { command: 'cat sample.txt && ls', commands: ['cat sample.txt', 'ls'] } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const asks: EnginePermissionRequest[] = [];

    await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: (request) => {
          asks.push(request);
          return Promise.resolve('once');
        },
      }),
    );

    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.tool, 'execute');
    assert.equal(asks[0]?.target, 'cat sample.txt && ls');
    // Every command the agent parsed out of the line, because this is what is being
    // agreed to and showing only the first would hide the rest.
    assert.deepEqual(asks[0]?.details, ['cat sample.txt', 'ls']);
    // The agent offers to remember the choice, so a lasting grant is worth offering.
    assert.deepEqual(asks[0]?.suggestions, ['execute(cat sample.txt && ls)']);
  });
});

test('allowing once picks the option the agent offered for it', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_06', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.resolve('once'),
      }),
    );

    assert.equal(textOf(events), 'chose:allow_once');
  });
});

test('a lasting grant is recorded here, so it still only allows the call on the wire', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_07', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.resolve('always'),
      }),
    );

    // 'always' is remembered on this machine rather than in the agent, so it must
    // not install a grant in Copilot's own configuration.
    assert.equal(textOf(events), 'chose:allow_once');
  });
});

test('a refusal is answered with the agent’s own deny option', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_08', title: 'Run rm', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf /' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.resolve('reject'),
      }),
    );

    assert.equal(textOf(events), 'chose:reject_once');
  });
});

test('a call is refused when nobody can be asked', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_09', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    // No requestPermission at all, which is what a caller that cannot ask looks
    // like. Allowing the call would bypass every limit set on this machine.
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(textOf(events), 'chose:reject_once');
  });
});

test('an ask nobody offered an option for cancels rather than being read as allowed', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_10', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }, []);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.resolve('once'),
      }),
    );

    assert.equal(textOf(events), 'cancelled');
  });
});

test('a caller that throws is treated as a refusal', async () => {
  const script = conversation(`
    ask({ toolCallId: 'toolu_11', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.reject(new Error('nobody answered')),
      }),
    );

    assert.equal(textOf(events), 'chose:reject_once');
  });
});

test('a refused call does not report the notice the agent fails it with', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'tool_call', toolCallId: 'toolu_12', title: 'Run rm', kind: 'execute', status: 'pending', rawInput: { command: 'rm file' } });
    ask({ toolCallId: 'toolu_12', title: 'Run rm', kind: 'execute', status: 'pending', rawInput: { command: 'rm file' } }, ALLOW_ALWAYS_DENY);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', {
        ...base,
        requestPermission: () => Promise.resolve('reject'),
      }),
    );

    // Only the caller knows why it refused, so the refusal is stated there. The
    // agent words it as the user having denied it, which would be a lie when a
    // limit on this machine refused or nobody was asked.
    assert.deepEqual(outputsOf(events), []);
  });
});

test('a conversation is continued and its replayed history is not relayed again', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('the new answer') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('what did I ask', {
        ...base,
        resume: '39095fff-8c9e-4f43-a486-37b089a0250c',
      }),
    );

    // Loading replays the earlier question and answer as ordinary updates. Relaying
    // them would repeat the whole conversation inside this one reply.
    assert.equal(textOf(events), 'the new answer');
  });
});

test('a session Copilot no longer has starts a new one instead of losing the turn', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered fresh') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', { ...base, resume: 'a-session-that-was-pruned' }),
    );

    assert.equal(textOf(events), 'answered fresh');
    // The failed load is not reported: the retry answered properly, so an error
    // about the stale id would describe a problem the user does not have.
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 0 });
  });
});

test('the chosen model is set on the session rather than passed on the command line', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered as ' + global.model) });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', { ...base, model: 'gpt-5.4-mini' }),
    );

    // Set on the session, because a continued conversation would otherwise keep
    // whatever model it was created with.
    assert.equal(textOf(events), 'answered as gpt-5.4-mini');
  });
});

test('a model the agent will not take is reported without losing the turn', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('answered on the default') });
    ${endTurn}
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(
      new CopilotEngine().prompt('hi', { ...base, model: 'not-a-model' }),
    );

    assert.equal(textOf(events), 'answered on the default');
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 0 });
    assert.match(
      events
        .filter((event): event is Extract<EngineEvent, { type: 'log' }> => event.type === 'log')
        .map((event) => event.text)
        .join(' '),
      /would not answer with not-a-model/,
    );
  });
});

test('a turn the agent declines to continue is reported as a failure', async () => {
  const script = conversation(`
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(
      events.some((event) => event.type === 'error'),
      true,
    );
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 1 });
  });
});

test('an agent that dies mid-turn ends the turn instead of hanging it', async () => {
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('half an ans') });
    process.exit(1);
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(textOf(events), 'half an ans');
    assert.equal(
      events.some((event) => event.type === 'error'),
      true,
    );
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 1 });
  });
});

test('stopping the turn tells the agent to cancel it', async () => {
  // The agent is told over session/cancel, and the prompt it was still answering
  // comes back with a stop reason of its own. Killing the process instead would
  // leave the agent no chance to stop the tool call it was in the middle of.
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('working') });
  `);

  await withFakeEngine('copilot', script, async () => {
    const controller = new AbortController();
    const events: EngineEvent[] = [];

    for await (const event of new CopilotEngine().prompt('hi', {
      ...base,
      signal: controller.signal,
    })) {
      events.push(event);

      if (event.type === 'delta') {
        controller.abort();
      }
    }

    // What had streamed before the stop is kept: a turn cut short still said
    // something, and dropping it would lose an answer the reader already saw.
    assert.equal(textOf(events), 'working');
    // A cancelled prompt is answered rather than failed, so the turn ends cleanly.
    // Reaching this at all is the proof that the cancel arrived: the fake only
    // answers the outstanding prompt when it is told to cancel, so an adapter that
    // dropped the stream without saying so would hang here instead.
    assert.deepEqual(events.at(-1), { type: 'done', exitCode: 0 });
  });
});

test('the models are read from the session, which is the only place they are reported', async () => {
  const script = conversation(endTurn);

  await withFakeEngine('copilot', script, async () => {
    assert.deepEqual(await new CopilotEngine().listModels(), [
      'auto',
      'claude-sonnet-5',
      'gpt-5.4-mini',
    ]);
  });
});

test('an agent that cannot report models leaves the engine on its default', async () => {
  // A machine with no login answers the handshake and refuses the session, which
  // must not stop the engine being offered.
  const script = agent(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }] } });
    return;
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Authentication required.' } });
    return;
  }
}
`);

  await withFakeEngine('copilot', script, async () => {
    assert.deepEqual(await new CopilotEngine().listModels(), []);
  });
});

test('nothing is reported as thinking, because Copilot streams none', async () => {
  // It counts its thinking in the usage it returns and streams no thought chunks,
  // so there is nothing here to relay. A reasoning event invented from the token
  // count would be a claim no recorded output supports.
  const script = conversation(`
    update({ sessionUpdate: 'agent_message_chunk', content: text('the answer') });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 15146, outputTokens: 20, totalTokens: 15166, thoughtTokens: 13 } } });
  `);

  await withFakeEngine('copilot', script, async () => {
    const events = await collect(new CopilotEngine().prompt('hi', base));

    assert.equal(
      events.some((event) => event.type === 'reasoning'),
      false,
    );
    assert.equal(textOf(events), 'the answer');
  });
});
