import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexEngine } from '../dist/adapters/codex.js';
import type { EngineEvent, EnginePermissionRequest, PromptOptions } from '../dist/types.js';
import { withFakeEngine } from './helpers.ts';

/**
 * Fakes built from traffic recorded from codex-cli 0.146.0 over `codex app-server`.
 *
 * The shapes here are the ones the real app server sent, which is why they are
 * narrower than the protocol allows: `turn/start` answers as soon as the turn is
 * accepted rather than when it ends, `turn/completed` names its turn inside the turn
 * it carries where every other notification names it beside the payload, a file
 * change ask carries no paths at all, and token usage arrives as a per-request
 * figure beside a running total for the whole thread.
 *
 * The framing is one JSON object per line, the same as ACP over stdio.
 */

/**
 * Builds a fake app server from a script fragment.
 *
 * `login status` is answered before anything else, because that is what discovery
 * asks first and a fake that cannot answer it reports no models at all.
 */
function server(body: string): string {
  return `#!/usr/bin/env node
if (process.argv[2] === 'login') {
  // On stderr, which is where the real CLI writes it. Read as stdout there is
  // nothing to match, and every machine looks logged out.
  process.stderr.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
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

/** Answers the handshake and the thread, then runs a test's own turn body. */
function conversation(turn: string, options: { threadId?: string } = {}): string {
  const threadId = options.threadId ?? 'thr_abc123';

  return server(`
const THREAD = ${JSON.stringify(threadId)};
const TURN = 'turn_1';
const note = (method, params) => send({ jsonrpc: '2.0', method, params });
const delta = (t) => note('item/agentMessage/delta', { threadId: THREAD, turnId: TURN, itemId: 'msg_1', delta: t });
const thought = (t) => note('item/reasoning/summaryTextDelta', { threadId: THREAD, turnId: TURN, itemId: 'rs_1', summaryIndex: 0, delta: t });
const startItem = (item) => note('item/started', { threadId: THREAD, turnId: TURN, startedAtMs: 1, item });
const endItem = (item) => note('item/completed', { threadId: THREAD, turnId: TURN, completedAtMs: 2, item });

/** Token usage as the real server reports it: this request beside the thread total. */
const spend = (i, o) => note('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: { total: { inputTokens: 99999, outputTokens: 99999 }, last: { inputTokens: i, outputTokens: o } } });

/** Ends the turn. The id lives inside the turn, not beside it. */
const finish = (status, error) => note('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], status: status ?? 'completed', error: error ?? null } });

/** Asks about a command, which describes itself. */
const askCommand = (itemId, command, actions) => send({ jsonrpc: '2.0', id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId, startedAtMs: 1, command, cwd: '/work', commandActions: (actions ?? []).map((c) => ({ type: 'unknown', command: c })) } });

/** Asks about a patch, which says nothing at all about what it would change. */
const askPatch = (itemId) => send({ jsonrpc: '2.0', id: 92, method: 'item/fileChange/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId, startedAtMs: 1 } });

function handle(msg) {
  // The answer to an ask. What was decided is said out loud so a test can read the
  // decision that actually reached the agent.
  if (msg.result && msg.result.decision) {
    delta('chose:' + msg.result.decision);
    finish();
    return;
  }
  // A request this adapter will not answer comes back as an error.
  if (msg.error) {
    delta('refused');
    finish();
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake', codexHome: '/home/.codex', platformFamily: 'unix', platformOs: 'macos' } });
    return;
  }
  if (msg.method === 'thread/start') {
    global.settings = msg.params;
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: THREAD, cwd: msg.params.cwd }, model: 'gpt-5.6-terra' } });
    note('thread/started', { thread: { id: THREAD } });
    return;
  }
  if (msg.method === 'thread/resume') {
    global.resumed = msg.params.threadId;
    // What the thread had already spent before this prompt, which is not this
    // turn's to report. The real server sends this on every resume.
    note('thread/tokenUsage/updated', { threadId: THREAD, turnId: 'turn_earlier', tokenUsage: { total: { inputTokens: 5000, outputTokens: 400 }, last: { inputTokens: 5000, outputTokens: 400 } } });
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params.threadId } } });
    return;
  }
  if (msg.method === 'turn/start') {
    global.model = msg.params.model;
    // Answered as soon as the turn is accepted, not when it is over.
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: TURN, status: 'inProgress' } } });
    ${turn}
    return;
  }
  if (msg.method === 'turn/interrupt') {
    global.interrupted = msg.params;
    finish('interrupted');
    return;
  }
  if (msg.method === 'model/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { data: [{ id: 'gpt-5.6-terra', hidden: false, isDefault: true }, { id: 'internal-eval', hidden: true }, { id: 'gpt-5.5', hidden: false }], nextCursor: null } });
    return;
  }
}
`);
}

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

function outputsOf(events: EngineEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<EngineEvent, { type: 'activity_output' }> =>
        event.type === 'activity_output',
    )
    .map((event) => event.output);
}

function sessionOf(events: EngineEvent[]): string | undefined {
  const found = events.find(
    (event): event is Extract<EngineEvent, { type: 'session' }> => event.type === 'session',
  );

  return found?.id;
}

const base: PromptOptions = { cwd: process.cwd() };

test('streamed fragments are forwarded in order', async () => {
  const script = conversation(`
    delta('Hel'); delta('lo '); delta('world');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'Hello world');
  });
});

test('thinking is reported as itself, not as the answer', async () => {
  // The summary streams through a notification of its own, so it never runs
  // together with the answer in the transcript. See ADR-037.
  const script = conversation(`
    thought('The user wants X, so I should check the files.');
    delta('Here is the answer.');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));

    assert.equal(textOf(events), 'Here is the answer.');
    assert.equal(reasoningOf(events), 'The user wants X, so I should check the files.');
  });
});

test('an answer that never streamed is still shown once', async () => {
  // A provider that answers in one piece reports the whole message on the finished
  // item instead of in fragments. Without this the turn would be silent.
  const script = conversation(`
    startItem({ type: 'agentMessage', id: 'msg_whole', text: '', phase: 'final_answer' });
    endItem({ type: 'agentMessage', id: 'msg_whole', text: 'answered in one piece', phase: 'final_answer' });
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'answered in one piece');
  });
});

test('a streamed answer is not repeated by the item that completes it', async () => {
  const script = conversation(`
    delta('streamed');
    endItem({ type: 'agentMessage', id: 'msg_1', text: 'streamed', phase: 'final_answer' });
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'streamed');
  });
});

test('the prompt is never replayed as the answer', async () => {
  const script = conversation(`
    startItem({ type: 'userMessage', id: 'user_1', content: [{ type: 'text', text: 'what did I ask' }] });
    endItem({ type: 'userMessage', id: 'user_1', content: [{ type: 'text', text: 'what did I ask' }] });
    delta('the answer');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('what did I ask', base));

    assert.equal(textOf(events), 'the answer');
    assert.deepEqual(activitiesOf(events), []);
  });
});

test('a command is reported once, with the line that actually runs', async () => {
  // Recorded from a shell call: the raw line is what the sandbox executes, and the
  // parsed action is what the agent meant by it.
  const script = conversation(`
    startItem({ type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'echo probe'", cwd: '/work', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'echo probe' }] });
    endItem({ type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'echo probe'", cwd: '/work', status: 'completed', commandActions: [{ type: 'unknown', command: 'echo probe' }], aggregatedOutput: 'probe\\n', exitCode: 0 });
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities.length, 1);
    assert.equal(activities[0]?.tool, 'shell');
    // The whole line, never cut and never reduced to the parsed part: this is what
    // a rule on this machine is judged against. See ADR-025.
    assert.equal(activities[0]?.target, "/bin/zsh -lc 'echo probe'");
    assert.deepEqual(outputsOf(events), ['probe']);
  });
});

test('a command that printed nothing still says how it went', async () => {
  const script = conversation(`
    endItem({ type: 'commandExecution', id: 'exec-2', command: 'false', cwd: '/work', status: 'failed', commandActions: [], aggregatedOutput: '', exitCode: 1 });
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.deepEqual(outputsOf(events), ['Exited with code 1.']);
  });
});

test('a patch names the files it touched and not their contents', async () => {
  const script = conversation(`
    endItem({ type: 'fileChange', id: 'patch-1', status: 'completed', changes: [{ path: 'note.txt', kind: 'add', diff: '@@ -0,0 +1 @@\\n+probe\\n' }] });
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const activities = activitiesOf(events);

    assert.equal(activities[0]?.tool, 'apply_patch');
    assert.equal(activities[0]?.target, 'note.txt');
    // The diff carries the whole new contents of the file, which is not the output
    // of the call and would put a file body in the transcript.
    assert.deepEqual(outputsOf(events), []);
  });
});

test('the thread is reported before any answer text', async () => {
  const script = conversation(`
    delta('answer');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const session = events.findIndex((event) => event.type === 'session');
    const delta = events.findIndex((event) => event.type === 'delta');

    assert.ok(session >= 0, 'the thread was never reported');
    assert.ok(session < delta, 'the thread was reported after the answer had started');
    assert.equal(sessionOf(events), 'thr_abc123');
  });
});

/** A turn that announces a command and then asks about it. */
const ASK_ABOUT_COMMAND = `
    startItem({ type: 'commandExecution', id: 'exec-1', command: "/bin/zsh -lc 'npm install && npm test'", cwd: '/work', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm install' }, { type: 'unknown', command: 'npm test' }] });
    askCommand('exec-1', "/bin/zsh -lc 'npm install && npm test'", ['npm install', 'npm test']);
`;

test('an ask names the command and every command inside it', async () => {
  await withFakeEngine('codex', conversation(ASK_ABOUT_COMMAND), async () => {
    const asks: EnginePermissionRequest[] = [];

    const events = await collect(
      new CodexEngine().prompt('hi', {
        ...base,
        requestPermission: async (request) => {
          asks.push(request);
          return 'once';
        },
      }),
    );

    assert.equal(asks.length, 1);
    assert.equal(asks[0]?.tool, 'shell');
    assert.equal(asks[0]?.target, "/bin/zsh -lc 'npm install && npm test'");
    // Both, not just the first: one ask covers several commands here, and agreeing
    // to one of them would mean agreeing to all. See ADR-022.
    assert.deepEqual(asks[0]?.details, ['npm install', 'npm test']);
    // None offered on purpose. Codex's own lasting grants are either a session
    // cache this project cannot clear or an execpolicy amendment written in its own
    // language, so the caller records what was actually agreed to instead.
    assert.deepEqual(asks[0]?.suggestions, []);
    assert.ok(events.some((event) => event.type === 'done'));
  });
});

test('a patch ask takes what it would do from the item that announced it', async () => {
  // The ask itself carries only ids, so read alone it would reach the phone as an
  // unnamed tool acting on nothing.
  const script = conversation(`
    startItem({ type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [{ path: 'src/app.ts', kind: 'update', diff: '' }, { path: 'README.md', kind: 'update', diff: '' }] });
    askPatch('patch-1');
  `);

  await withFakeEngine('codex', script, async () => {
    const asks: EnginePermissionRequest[] = [];

    await collect(
      new CodexEngine().prompt('hi', {
        ...base,
        requestPermission: async (request) => {
          asks.push(request);
          return 'once';
        },
      }),
    );

    assert.equal(asks[0]?.tool, 'apply_patch');
    assert.equal(asks[0]?.target, 'src/app.ts, README.md');
    assert.deepEqual(asks[0]?.details, ['src/app.ts', 'README.md']);
  });
});

test('an ask nobody can answer is refused', async () => {
  // No requestPermission means nobody is able to answer, and the alternative to
  // refusing is running a tool call nobody agreed to.
  await withFakeEngine('codex', conversation(ASK_ABOUT_COMMAND), async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'chose:decline');
  });
});

test('a caller that throws refuses the call', async () => {
  await withFakeEngine('codex', conversation(ASK_ABOUT_COMMAND), async () => {
    const events = await collect(
      new CodexEngine().prompt('hi', {
        ...base,
        requestPermission: async () => {
          throw new Error('the browser went away');
        },
      }),
    );

    assert.equal(textOf(events), 'chose:decline');
  });
});

test('always allows on the wire, because the grant is kept here', async () => {
  // Not acceptForSession: that grant lives in Codex for the life of a process this
  // project starts and stops per turn, so it would be forgotten anyway, and it
  // could not be listed or cleared from Setup. See ADR-022.
  await withFakeEngine('codex', conversation(ASK_ABOUT_COMMAND), async () => {
    const events = await collect(
      new CodexEngine().prompt('hi', { ...base, requestPermission: async () => 'always' }),
    );

    assert.equal(textOf(events), 'chose:accept');
  });
});

test('a call refused through an ask is not also reported as blocked', async () => {
  // The reason is only known a level up: a person may have said no, or a limit on
  // this machine may have. Reporting it here would state it twice, and credit it to
  // the engine. See ADR-022.
  const script = conversation(`
    startItem({ type: 'commandExecution', id: 'exec-1', command: 'rm -rf /', cwd: '/work', status: 'inProgress', commandActions: [] });
    askCommand('exec-1', 'rm -rf /', ['rm -rf /']);
    endItem({ type: 'commandExecution', id: 'exec-1', command: 'rm -rf /', cwd: '/work', status: 'declined', commandActions: [] });
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(
      new CodexEngine().prompt('hi', { ...base, requestPermission: async () => 'reject' }),
    );

    assert.ok(!events.some((event) => event.type === 'blocked'));
  });
});

test('a call Codex declined without asking is reported as blocked', async () => {
  // Its sandbox and approval policy can refuse on their own. Without this the
  // answer that works around the refusal has no visible cause.
  const script = conversation(`
    endItem({ type: 'commandExecution', id: 'exec-9', command: 'curl http://example.com', cwd: '/work', status: 'declined', commandActions: [] });
    delta('I could not reach the network.');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(
      new CodexEngine().prompt('hi', { ...base, requestPermission: async () => 'once' }),
    );
    const blocked = events.find(
      (event): event is Extract<EngineEvent, { type: 'blocked' }> => event.type === 'blocked',
    );

    assert.equal(blocked?.tool, 'shell');
    assert.match(blocked?.reason ?? '', /decided alone/);
  });
});

test('a request this adapter cannot answer is refused, not ignored', async () => {
  // A permission profile answered by guessing would grant something nobody agreed
  // to, and left unanswered it would stall the turn.
  const script = conversation(`
    send({ jsonrpc: '2.0', id: 77, method: 'item/permissions/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'perm_1', startedAtMs: 1, cwd: '/work', permissions: {} } });
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'refused');
  });
});

test('token usage is this turn only, summed over its requests', async () => {
  const script = conversation(`
    spend(100, 10);
    spend(50, 5);
    delta('done');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const usage = events.find(
      (event): event is Extract<EngineEvent, { type: 'usage' }> => event.type === 'usage',
    );

    // The per-request figures added up, never the thread total beside them, which
    // counts every earlier turn in the conversation.
    assert.equal(usage?.inputTokens, 150);
    assert.equal(usage?.outputTokens, 15);
  });
});

test('what a resumed thread already spent is not billed to this turn', async () => {
  const script = conversation(`
    spend(100, 10);
    delta('continued');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', { ...base, resume: 'thr_abc123' }));
    const usage = events.find(
      (event): event is Extract<EngineEvent, { type: 'usage' }> => event.type === 'usage',
    );

    assert.equal(textOf(events), 'continued');
    assert.equal(usage?.inputTokens, 100);
    assert.equal(usage?.outputTokens, 10);
  });
});

test('a thread to continue is resumed rather than started fresh', async () => {
  const script = conversation(`
    delta(global.resumed ? 'continued:' + global.resumed : 'fresh');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(
      new CodexEngine().prompt('hi', { ...base, resume: 'thr_earlier' }),
    );

    assert.equal(textOf(events), 'continued:thr_earlier');
    // The id is the one that was asked for: a resume reports no new id.
    assert.equal(sessionOf(events), 'thr_earlier');
  });
});

test('a stale thread falls back to answering fresh', async () => {
  // Threads live in Codex's own store and can be pruned at any time. Answering
  // without the earlier context is better than refusing to answer.
  const script = conversation(`
    delta('answered fresh');
    finish();
  `).replace(
    "if (msg.method === 'thread/resume') {",
    `if (msg.method === 'thread/resume') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'no rollout found for thread id ' + msg.params.threadId } });
    return;
  }
  if (msg.method === '_never') {`,
  );

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', { ...base, resume: 'thr_gone' }));

    assert.equal(textOf(events), 'answered fresh');
    // The failed resume is not reported: the retry answered properly.
    assert.ok(!events.some((event) => event.type === 'error'));
    assert.equal(sessionOf(events), 'thr_abc123');
  });
});

test('the approval policy and the sandbox are set on the thread', async () => {
  // Load-bearing. Left to the user's config.toml, an approval policy of `never`
  // would have Codex decide every call alone, and a sandbox of danger-full-access
  // would let it do anything, which is what the limits on this machine exist to
  // prevent. See ADR-048.
  const script = conversation(`
    delta(global.settings.approvalPolicy + '/' + global.settings.sandbox + '/' + global.settings.cwd);
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));

    // The workspace is named as well as entered, so the thread works where the
    // prompt was asked rather than wherever the process happened to start.
    assert.equal(textOf(events), `on-request/read-only/${base.cwd}`);
  });
});

test('a chosen model is asked of the turn, not left to the default', async () => {
  // Told per turn rather than per thread, so a model changed in the browser reaches
  // a conversation that already exists.
  const script = conversation(`
    delta('model:' + String(global.model));
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', { ...base, model: 'gpt-5.5' }));

    assert.equal(textOf(events), 'model:gpt-5.5');
  });
});

test('a failed turn is reported as a failure, in the engine words', async () => {
  const script = conversation(`
    finish('failed', { message: 'the model is over its quota' });
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const failure = events.find(
      (event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error',
    );

    assert.match(failure?.message ?? '', /over its quota/);
    assert.equal(
      events.find((event): event is Extract<EngineEvent, { type: 'done' }> => event.type === 'done')
        ?.exitCode,
      1,
    );
  });
});

test('a failure the engine will retry does not end the turn', async () => {
  const script = conversation(`
    note('error', { threadId: THREAD, turnId: TURN, willRetry: true, error: { message: 'stream disconnected, retrying' } });
    delta('answered on the retry');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));

    assert.equal(textOf(events), 'answered on the retry');
    assert.ok(!events.some((event) => event.type === 'error'));
    // Said out loud rather than swallowed, since the turn took longer for a reason.
    assert.ok(events.some((event) => event.type === 'log' && /retrying/.test(event.text)));
  });
});

test('a stopped turn interrupts the engine rather than only dropping the stream', async () => {
  // The engine is a separate process, so abandoning the stream alone would leave it
  // working on an answer nobody wants. See ADR-042.
  const script = conversation(`
    delta('working');
  `);

  await withFakeEngine('codex', script, async () => {
    const controller = new AbortController();
    const events: EngineEvent[] = [];

    for await (const event of new CodexEngine().prompt('hi', {
      ...base,
      signal: controller.signal,
    })) {
      events.push(event);

      if (event.type === 'delta') {
        controller.abort();
      }
    }

    // An interrupted turn is a turn the caller stopped, not one that failed.
    assert.ok(!events.some((event) => event.type === 'error'));
    assert.ok(events.some((event) => event.type === 'done'));
  });
});

test('a line that is not JSON does not derail the turn', async () => {
  const script = conversation(`
    process.stdout.write('warning: something happened\\n');
    delta('still fine');
    finish();
  `);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    assert.equal(textOf(events), 'still fine');
  });
});

test('an app server that dies mid-turn reports it instead of hanging', async () => {
  const script = server(`
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } });
    return;
  }
  if (msg.method === 'thread/start') {
    process.exit(1);
  }
}
`);

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));

    assert.ok(events.some((event) => event.type === 'error'));
    assert.ok(events.some((event) => event.type === 'done'));
  });
});

test('a missing login is reported as the command that fixes it', async () => {
  // How the real CLI refuses: a line on stderr, then it exits. No JSON-RPC error
  // ever arrives, so the wording is the only thing there is to read.
  const script = `#!/usr/bin/env node
process.stderr.write('Not logged in. Run codex login to continue.\\n');
process.exit(1);
`;

  await withFakeEngine('codex', script, async () => {
    const events = await collect(new CodexEngine().prompt('hi', base));
    const failure = events.find(
      (event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error',
    );

    assert.match(failure?.message ?? '', /codex login/);
    // The engine's own line is not relayed on top of the explanation, which would
    // report the same problem twice.
    assert.ok(!events.some((event) => event.type === 'log' && /not logged in/i.test(event.text)));
  });
});

test('models are read from the listing, without the hidden ones', async () => {
  await withFakeEngine('codex', conversation(''), async () => {
    // Hidden models are the ones Codex keeps out of its own picker, so offering
    // them would put a choice in the browser the engine does not consider current.
    assert.deepEqual(await new CodexEngine().listModels(), ['gpt-5.6-terra', 'gpt-5.5']);
  });
});

test('a machine with nobody logged in offers no models rather than failing', async () => {
  const script = `#!/usr/bin/env node
if (process.argv[2] === 'login') {
  // Nonzero is the whole answer. The message is on stderr either way, which is why
  // the login is read from the status and not from what it said.
  process.stderr.write('Not logged in\\n');
  process.exit(1);
}
process.exit(0);
`;

  await withFakeEngine('codex', script, async () => {
    // Empty means "use the engine default", so the engine is still offered once
    // somebody logs in.
    assert.deepEqual(await new CodexEngine().listModels(), []);
  });
});
