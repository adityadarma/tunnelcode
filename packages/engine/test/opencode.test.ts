import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeEngine } from '../dist/adapters/opencode.js';
import type { EngineEvent } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fake opencode. Emits cumulative text parts, which is what the real
 * `opencode run --format json` does: every event repeats the whole part.
 */
const CUMULATIVE = `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('opencode/fast\\nopencode/slow\\nnot a model line\\n');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  for (const text of ['Hel', 'Hello', 'Hello wor', 'Hello world']) {
    process.stdout.write(JSON.stringify({ type: 'text', part: { id: 'p1', type: 'text', text } }) + '\\n');
  }
  process.stderr.write('diagnostic noise\\n');
  process.exit(0);
});
`;

const ECHO_ARGS = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const payload = JSON.stringify({ args: process.argv.slice(2), input: input });
  process.stdout.write(JSON.stringify({ type: 'text', part: { id: 'p1', type: 'text', text: payload } }) + '\\n');
  process.exit(0);
});
`;

const FAILING = `#!/usr/bin/env node
process.stderr.write('engine blew up\\n');
process.exit(3);
`;

/**
 * Reports a session id on every event, the way the real CLI does, and records
 * the id it was asked to continue so a test can assert what reached the engine.
 */
const SESSION_ECHO = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
const at = args.indexOf('--session');
const resumed = at === -1 ? undefined : args[at + 1];
const sid = resumed === undefined ? 'ses_new' : resumed;
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'step_start', sessionID: sid, part: { id: 'sp1', type: 'step-start' } });
  out({ type: 'text', sessionID: sid, part: { id: 'p1', type: 'text', text: 'resumed=' + String(resumed) } });
  out({ type: 'step_finish', sessionID: sid, part: { id: 'sp2', type: 'step-finish' } });
  process.exit(0);
});
`;

/**
 * Refuses a session id it cannot find, the way the real CLI does: exit 1 with
 * the explanation only on stderr and no events at all on stdout.
 */
const STALE_SESSION = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
const at = args.indexOf('--session');
process.stdin.resume();
process.stdin.on('end', () => {
  if (at !== -1) {
    process.stderr.write('Error: Session not found\\n');
    process.exit(1);
    return;
  }
  out({ type: 'text', sessionID: 'ses_fresh', part: { id: 'p1', type: 'text', text: 'fresh answer' } });
  process.exit(0);
});
`;

/**
 * Emits tool calls the way a recorded run does: the line type is `tool_use` while
 * the part inside it is `tool`, and the call is identified by callID rather than
 * by an id.
 *
 * Two calls to the same tool are included because sharing one dedup key would
 * collapse them into a single activity.
 */
const TOOL_PARTS = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'tool_use', part: { type: 'tool', id: 'call_1', tool: 'edit', callID: 'call_1', state: { status: 'running', input: { filePath: 'src/a.ts' } } } });
  out({ type: 'tool_use', part: { type: 'tool', id: 'call_1', tool: 'edit', callID: 'call_1', state: { status: 'completed', input: { filePath: 'src/a.ts' } } } });
  out({ type: 'tool_use', part: { type: 'tool', id: 'call_2', tool: 'bash', callID: 'call_2', state: { status: 'completed', input: { command: 'pnpm test' } } } });
  out({ type: 'tool_use', part: { type: 'tool', id: 'call_1', tool: 'edit', callID: 'call_3', state: { status: 'completed', input: { filePath: 'src/b.ts' } } } });
  out({ type: 'text', part: { id: 'p1', type: 'text', text: 'Done.' } });
  process.exit(0);
});
`;

/**
 * Reproduces a tool call refused on permission grounds, recorded from the real
 * CLI at version 1.18.9.
 *
 * Unlike claude, opencode reports the refusal on the tool part itself, as a
 * status of error carrying the reason. The call is announced first and refused on
 * a later repeat of the same part, which is exactly what the dedupe by call id
 * would otherwise swallow.
 */
const BLOCKED_TOOL = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'write', callID: 'call_1', state: { status: 'running', input: { filePath: '/outside/note.txt' } } } });
  out({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', tool: 'write', callID: 'call_1', state: { status: 'error', input: { filePath: '/outside/note.txt' }, error: 'The user rejected permission to use this specific tool call.' } } });
  out({ type: 'text', sessionID: 'ses_1', part: { id: 'p1', type: 'text', text: 'I could not write it.' } });
  process.exit(0);
});
`;

/**
 * A tool that simply failed, which carries the same error status as a refusal.
 * Only the wording separates the two.
 */
const FAILED_TOOL = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'tool_use', sessionID: 'ses_1', part: { type: 'tool', id: 'call_2', tool: 'bash', callID: 'call_1', state: { status: 'error', input: { command: 'ls /nope' }, error: 'ls: /nope: No such file or directory' } } });
  process.exit(0);
});
`;

/** Records the args it was launched with, so a test can assert what was passed. */
const ARGS_ECHO = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'text', sessionID: 'ses_1', part: { id: 'p1', type: 'text', text: JSON.stringify(args) } });
  process.exit(0);
});
`;

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

type Session = Extract<EngineEvent, { type: 'session' }>;

function sessionsOf(events: EngineEvent[]): Session[] {
  return events.filter((event): event is Session => event.type === 'session');
}

type Blocked = Extract<EngineEvent, { type: 'blocked' }>;

function blockedOf(events: EngineEvent[]): Blocked[] {
  return events.filter((event): event is Blocked => event.type === 'blocked');
}

test('cumulative text is emitted only once', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    // Four cumulative parts must not become "HelHelloHello wor...".
    assert.equal(textOf(events), 'Hello world');
  });
});

test('each delta carries only the new fragment', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const deltas = events.filter((event) => event.type === 'delta');

    assert.deepEqual(
      deltas.map((event) => (event.type === 'delta' ? event.text : '')),
      ['Hel', 'lo', ' wor', 'ld'],
    );
  });
});

test('stderr becomes a log, never conversation text', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const logs = events.filter((event) => event.type === 'log');

    assert.equal(logs.length, 1);
    assert.ok(!textOf(events).includes('diagnostic'));
  });
});

test('the stream ends with a done event', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const last = events.at(-1);

    assert.equal(last?.type, 'done');
    assert.equal(last?.type === 'done' ? last.exitCode : -1, 0);
  });
});

test('the prompt travels on stdin, not in argv', async () => {
  await withFakeEngine('opencode', ECHO_ARGS, async () => {
    const prompt = 'he said "hi" & $(whoami)';
    const events = await collect(new OpenCodeEngine().prompt(prompt, { cwd: process.cwd() }));
    const payload = JSON.parse(textOf(events)) as { args: string[]; input: string };

    // Shell metacharacters must arrive unexpanded and out of the command line.
    assert.equal(payload.input.trim(), prompt);
    assert.ok(!payload.args.includes(prompt));
  });
});

test('a chosen model is passed to the engine', async () => {
  await withFakeEngine('opencode', ECHO_ARGS, async () => {
    const events = await collect(
      new OpenCodeEngine().prompt('hi', { cwd: process.cwd(), model: 'opencode/fast' }),
    );
    const payload = JSON.parse(textOf(events)) as { args: string[] };

    assert.ok(payload.args.includes('--model'));
    assert.ok(payload.args.includes('opencode/fast'));
  });
});

test('a nonzero exit is reported', async () => {
  await withFakeEngine('opencode', FAILING, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const done = events.at(-1);

    assert.equal(done?.type === 'done' ? done.exitCode : 0, 3);
  });
});

test('models are read from the engine and junk lines dropped', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    assert.deepEqual(await new OpenCodeEngine().listModels(), ['opencode/fast', 'opencode/slow']);
  });
});

test('a tool call is reported once, not per update', async () => {
  await withFakeEngine('opencode', TOOL_PARTS, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    // A call is repeated as it progresses, so reading every update would show the
    // same edit twice. Two edits with different callIDs must still both appear:
    // keying on the tool name alone would merge them.
    assert.deepEqual(activitiesOf(events), [
      { type: 'activity', id: 'call_1', tool: 'edit', target: 'src/a.ts' },
      { type: 'activity', id: 'call_2', tool: 'bash', target: 'pnpm test' },
      { type: 'activity', id: 'call_1', tool: 'edit', id: 'call_3', target: 'src/b.ts' },
    ]);
  });
});

test('a new session is given a title', async () => {
  await withFakeEngine('opencode', ARGS_ECHO, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const args = JSON.parse(textOf(events)) as string[];

    // Without a title opencode names the session from the prompt, and that
    // generated name arrives as the only text of the run: no tool is called and
    // the real answer never appears.
    assert.ok(args.includes('--title'));
  });
});

test('a resumed session is not retitled', async () => {
  await withFakeEngine('opencode', ARGS_ECHO, async () => {
    const events = await collect(
      new OpenCodeEngine().prompt('hi', { cwd: process.cwd(), resume: 'ses_earlier' }),
    );
    const args = JSON.parse(textOf(events)) as string[];

    // It already has one, and renaming somebody else's session is not this
    // adapter's business.
    assert.ok(args.includes('--session'));
    assert.ok(!args.includes('--title'));
  });
});

test('tool parts never become conversation text', async () => {
  await withFakeEngine('opencode', TOOL_PARTS, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.equal(textOf(events), 'Done.');
  });
});

test('a run without tools reports no activity', async () => {
  await withFakeEngine('opencode', CUMULATIVE, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.deepEqual(activitiesOf(events), []);
  });
});

test('the session id is reported once, so the next prompt can continue it', async () => {
  await withFakeEngine('opencode', SESSION_ECHO, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    // Every event names the session, so reading them all would report it thrice.
    assert.deepEqual(sessionsOf(events), [{ type: 'session', id: 'ses_new' }]);
  });
});

test('the session is reported before any answer text', async () => {
  await withFakeEngine('opencode', SESSION_ECHO, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));
    const session = events.findIndex((event) => event.type === 'session');
    const delta = events.findIndex((event) => event.type === 'delta');

    // A run cut short halfway must still have left an id to continue from.
    assert.ok(session !== -1 && session < delta);
  });
});

test('a session to continue is passed to the engine', async () => {
  await withFakeEngine('opencode', SESSION_ECHO, async () => {
    const events = await collect(
      new OpenCodeEngine().prompt('hi', { cwd: process.cwd(), resume: 'ses_earlier' }),
    );

    // This is what gives the agent memory of what was already said.
    assert.equal(textOf(events), 'resumed=ses_earlier');
    assert.deepEqual(sessionsOf(events), [{ type: 'session', id: 'ses_earlier' }]);
  });
});

test('a fresh prompt asks for no session', async () => {
  await withFakeEngine('opencode', SESSION_ECHO, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.equal(textOf(events), 'resumed=undefined');
  });
});

test('a stale session falls back to answering fresh', async () => {
  await withFakeEngine('opencode', STALE_SESSION, async () => {
    const events = await collect(
      new OpenCodeEngine().prompt('hi', { cwd: process.cwd(), resume: 'ses_pruned' }),
    );

    // Engine sessions live outside this project and can be pruned at any time,
    // so answering without the earlier context beats refusing to answer.
    assert.equal(textOf(events), 'fresh answer');
    assert.deepEqual(sessionsOf(events), [{ type: 'session', id: 'ses_fresh' }]);
  });
});

test('a stale session is not reported as an error', async () => {
  await withFakeEngine('opencode', STALE_SESSION, async () => {
    const events = await collect(
      new OpenCodeEngine().prompt('hi', { cwd: process.cwd(), resume: 'ses_pruned' }),
    );

    // The retry answered, so the first attempt's failure would only confuse.
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      [],
    );
    assert.equal(events.filter((event) => event.type === 'done').length, 1);
    assert.equal(events.at(-1)?.type === 'done' ? events.at(-1)?.exitCode : -1, 0);
  });
});

test('a missing engine reports unavailable instead of throwing', async () => {
  await withEmptyPath(async () => {
    const engine = new OpenCodeEngine();

    assert.equal(await engine.isAvailable(), false);
    assert.deepEqual(await engine.listModels(), []);

    const events = await collect(engine.prompt('hi', { cwd: process.cwd() }));
    assert.equal(events.at(0)?.type, 'error');
    assert.equal(events.at(-1)?.type === 'done' ? events.at(-1)?.exitCode : 0, 127);
  });
});

test('a refused tool call is reported instead of vanishing', async () => {
  await withFakeEngine('opencode', BLOCKED_TOOL, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    const blocked = blockedOf(events);

    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.tool, 'write');
    assert.match(blocked[0]?.reason ?? '', /rejected permission/);
  });
});

test('a refusal survives the dedupe that hides repeated tool parts', async () => {
  await withFakeEngine('opencode', BLOCKED_TOOL, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    // The call is announced once and refused on a later repeat of the same part.
    // Reporting the activity per call id must not also discard the refusal.
    assert.deepEqual(
      activitiesOf(events).map((event) => event.tool),
      ['write'],
    );
    assert.equal(blockedOf(events).length, 1);

    // The answer that follows still has to come through.
    assert.equal(textOf(events), 'I could not write it.');
  });
});

test('a tool that merely failed is not reported as refused', async () => {
  await withFakeEngine('opencode', FAILED_TOOL, async () => {
    const events = await collect(new OpenCodeEngine().prompt('hi', { cwd: process.cwd() }));

    // A command that exited nonzero is the engine's business, not a permission
    // problem the user has to see.
    assert.deepEqual(blockedOf(events), []);
  });
});
