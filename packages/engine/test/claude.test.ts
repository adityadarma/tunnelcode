import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeEngine } from '../dist/adapters/claude.js';
import type { EngineEvent } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fake claude. Emits stream-json where each content_block_delta already carries
 * only the new fragment, which is how the real CLI behaves.
 */
const STREAMING = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const text of ['Hel', 'lo ', 'world']) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  }
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world' });
  process.exit(0);
});
`;

/** Reproduces an authentication failure: exit code 0 but is_error true. */
const AUTH_FAILURE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in \\u00b7 Please run /login' });
  process.exit(0);
});
`;

const ECHO_ARGS = `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const payload = JSON.stringify({ args: process.argv.slice(2), input });
  process.stdout.write(JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: payload } },
  }) + '\\n');
  process.exit(0);
});
`;

/**
 * Reproduces a run that used a tool, as recorded from the real CLI.
 *
 * The tool call is announced before its arguments exist and they then arrive as
 * input_json_delta fragments, while the `assistant` line repeats the same call
 * with its arguments already assembled. Both are emitted here so the adapter has
 * to pick the one it can actually read.
 */
const TOOL_USE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'Write-1', name: 'Write', input: {} } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/note.txt","content":"hello"}' } } });
  out({ type: 'assistant', message: { content: [ { type: 'tool_use', id: 'Write-1', name: 'Write', input: { file_path: '/tmp/note.txt', content: 'hello' } } ] } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Created it.' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Created it.' });
  process.exit(0);
});
`;

/**
 * Records the session id it was asked to resume, so a test can assert what
 * reached the engine.
 *
 * The result line reports a stable id while the hook lines report a different
 * one, which is how the real CLI behaves once a session is resumed.
 */
const SESSION_ECHO = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const resumed = at === -1 ? undefined : args[at + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'hook_started', session_id: 'hook-id-ignore-me' });
  out({ type: 'system', subtype: 'init', session_id: 'session-abc' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'resumed=' + String(resumed) } } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-abc', result: 'ok' });
  process.exit(0);
});
`;

/**
 * Refuses a session id it cannot find, the way the real CLI does: exit 1, the
 * explanation only on stderr, and a generic error on the result line.
 */
const STALE_SESSION = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
process.stdin.resume();
process.stdin.on('end', () => {
  if (at !== -1) {
    process.stderr.write('No conversation found with session ID: ' + args[at + 1] + '\\n');
    out({ type: 'result', subtype: 'error_during_execution', is_error: true });
    process.exit(1);
    return;
  }
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fresh answer' } } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'session-new', result: 'fresh answer' });
  process.exit(0);
});
`;

/** One assistant message carrying two tool calls at once. */
const TWO_TOOLS = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'text', text: 'thinking' },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls -la' } },
  ] } });
  process.exit(0);
});
`;

/**
 * Reproduces a tool call refused on permission grounds, recorded from the real
 * CLI at version 2.1.159.
 *
 * The refusal arrives on a `user` line as a tool_result, and the turn carries on:
 * the model explains itself and the run exits successfully. Nothing else reports
 * that the call never happened.
 */
const BLOCKED_TOOL = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'Write-1', name: 'Write', input: { file_path: '/outside/note.txt', content: 'x' } },
  ] } });
  out({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'Write-1', is_error: true, content: "Claude requested permissions to write to /outside/note.txt, but you haven't granted it yet." },
  ] } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I could not write it.' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'I could not write it.', session_id: 's1' });
  process.exit(0);
});
`;

/**
 * A tool that simply failed, which looks the same as a refusal on the wire: an
 * is_error tool_result. Only the wording separates the two.
 */
const FAILED_TOOL = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'Bash-1', name: 'Bash', input: { command: 'ls /nope' } },
  ] } });
  out({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'Bash-1', is_error: true, content: 'ls: /nope: No such file or directory' },
  ] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'It does not exist.', session_id: 's1' });
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

test('text deltas are forwarded in order', async () => {
  await withFakeEngine('claude', STREAMING, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.equal(textOf(events), 'Hello world');
  });
});

test('fragments are not de-duplicated', async () => {
  await withFakeEngine('claude', STREAMING, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));
    const deltas = events.filter((event) => event.type === 'delta');

    // Claude already sends only new text, unlike opencode.
    assert.equal(deltas.length, 3);
  });
});

test('system and result lines are not conversation text', async () => {
  await withFakeEngine('claude', STREAMING, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.ok(!textOf(events).includes('session_id'));
    assert.ok(!textOf(events).includes('init'));
  });
});

test('a failure reported with exit code 0 is still a failure', async () => {
  await withFakeEngine('claude', AUTH_FAILURE, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));
    const failure = events.find((event) => event.type === 'error');

    // Without this the browser would see an empty answer and no explanation.
    assert.ok(failure !== undefined);
    assert.match(failure.type === 'error' ? failure.message : '', /Not logged in/);
  });
});

test('the prompt travels on stdin, not in argv', async () => {
  await withFakeEngine('claude', ECHO_ARGS, async () => {
    const prompt = 'rm -rf / ; echo "pwned"';
    const events = await collect(new ClaudeEngine().prompt(prompt, { cwd: process.cwd() }));
    const payload = JSON.parse(textOf(events)) as { args: string[]; input: string };

    assert.equal(payload.input.trim(), prompt);
    assert.ok(!payload.args.includes(prompt));
  });
});

test('a chosen model is passed to the engine', async () => {
  await withFakeEngine('claude', ECHO_ARGS, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), model: 'sonnet' }),
    );
    const payload = JSON.parse(textOf(events)) as { args: string[] };

    assert.ok(payload.args.includes('--model'));
    assert.ok(payload.args.includes('sonnet'));
  });
});

test('model aliases are offered when the engine is installed', async () => {
  await withFakeEngine('claude', STREAMING, async () => {
    // Claude Code cannot enumerate models, so the aliases its flag accepts are
    // the only stable choice.
    assert.deepEqual(await new ClaudeEngine().listModels(), ['opus', 'sonnet', 'haiku']);
  });
});

test('a missing engine offers no models', async () => {
  await withEmptyPath(async () => {
    const engine = new ClaudeEngine();

    assert.equal(await engine.isAvailable(), false);
    assert.deepEqual(await engine.listModels(), []);
  });
});

test('a tool call is reported with what it acted on', async () => {
  await withFakeEngine('claude', TOOL_USE, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.deepEqual(activitiesOf(events), [
      { type: 'activity', id: 'Write-1', tool: 'Write', target: '/tmp/note.txt' },
    ]);
  });
});

test('a tool call is reported once, not per fragment', async () => {
  await withFakeEngine('claude', TOOL_USE, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // The same call appears as a stream event and as an assistant line. Reading
    // both would show the edit twice.
    assert.equal(activitiesOf(events).length, 1);
  });
});

test('tool arguments never leak into the answer', async () => {
  await withFakeEngine('claude', TOOL_USE, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // input_json_delta is not conversation text, so none of it may reach the
    // transcript.
    assert.equal(textOf(events), 'Created it.');
    assert.ok(!textOf(events).includes('file_path'));
  });
});

test('several tool calls in one message are all reported', async () => {
  await withFakeEngine('claude', TWO_TOOLS, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.deepEqual(activitiesOf(events), [
      { type: 'activity', id: 't1', tool: 'Read', target: 'a.ts' },
      { type: 'activity', id: 't2', tool: 'Bash', target: 'ls -la' },
    ]);
  });
});

test('a run without tools reports no activity', async () => {
  await withFakeEngine('claude', STREAMING, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.deepEqual(activitiesOf(events), []);
  });
});

test('the session id is reported so the next prompt can continue it', async () => {
  await withFakeEngine('claude', SESSION_ECHO, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.deepEqual(sessionsOf(events), [{ type: 'session', id: 'session-abc' }]);
  });
});

test('the session id comes from the result line, not the hook lines', async () => {
  await withFakeEngine('claude', SESSION_ECHO, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // Resuming makes the hook lines report a different id. Storing that one would
    // break the next resume.
    assert.ok(!sessionsOf(events).some((event) => event.id === 'hook-id-ignore-me'));
  });
});

test('a session to continue is passed to the engine', async () => {
  await withFakeEngine('claude', SESSION_ECHO, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), resume: 'session-xyz' }),
    );

    assert.equal(textOf(events), 'resumed=session-xyz');
  });
});

test('no session to continue starts the engine fresh', async () => {
  await withFakeEngine('claude', SESSION_ECHO, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    assert.equal(textOf(events), 'resumed=undefined');
  });
});

test('a stale session still gets an answer', async () => {
  await withFakeEngine('claude', STALE_SESSION, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), resume: 'long-gone' }),
    );

    // Engine sessions live outside this project and can be pruned at any time, so
    // refusing to answer would be worse than answering without the old context.
    assert.equal(textOf(events), 'fresh answer');
    assert.equal(events.at(-1)?.type === 'done' ? events.at(-1)?.exitCode : -1, 0);
  });
});

test('a stale session is not reported as a failure', async () => {
  await withFakeEngine('claude', STALE_SESSION, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), resume: 'long-gone' }),
    );

    // The retry answered, so the first attempt's failure is noise the user would
    // only find confusing.
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      [],
    );
  });
});

test('a retry after a stale session reports the new id', async () => {
  await withFakeEngine('claude', STALE_SESSION, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), resume: 'long-gone' }),
    );

    // Without this the conversation would resume into the dead id forever.
    assert.deepEqual(sessionsOf(events), [{ type: 'session', id: 'session-new' }]);
  });
});

test('a real failure while resuming is still reported', async () => {
  await withFakeEngine('claude', AUTH_FAILURE, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', { cwd: process.cwd(), resume: 'session-abc' }),
    );

    const failure = events.find((event) => event.type === 'error');

    // Only a missing session justifies a silent retry. Anything else has to reach
    // the user.
    assert.ok(failure !== undefined);
    assert.match(failure.type === 'error' ? failure.message : '', /Not logged in/);
  });
});

test('a refused tool call is reported instead of vanishing', async () => {
  await withFakeEngine('claude', BLOCKED_TOOL, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // The refusal arrives on a user line, which the adapter used to drop, leaving
    // the answer that followed with no visible cause.
    const blocked = blockedOf(events);

    assert.equal(blocked.length, 1);
    // Named from the tool_use, because the tool_result only carries its id.
    assert.equal(blocked[0]?.tool, 'Write');
    assert.match(blocked[0]?.reason ?? '', /requested permissions/);
  });
});

test('a refusal does not stop the rest of the turn', async () => {
  await withFakeEngine('claude', BLOCKED_TOOL, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // Claude answers around a refusal rather than failing, so reporting one must
    // not swallow the answer or invent a failure.
    assert.equal(textOf(events), 'I could not write it.');
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
  });
});

test('a tool that merely failed is not reported as refused', async () => {
  await withFakeEngine('claude', FAILED_TOOL, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // A command that exited nonzero is the engine's business. Reporting it as a
    // permission problem would be wrong and noisy.
    assert.deepEqual(blockedOf(events), []);
  });
});
