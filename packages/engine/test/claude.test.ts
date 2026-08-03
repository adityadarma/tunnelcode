import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeEngine } from '../dist/adapters/claude.js';
import type { EngineEvent, EnginePermissionRequest } from '../dist/types.js';
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

/**
 * A run that thinks before it answers.
 *
 * Thinking arrives on a content block of its own, through the same
 * content_block_delta as an answer, and names its field after itself rather than
 * calling it text. Only the delta type separates the two.
 */
const THINKING = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The user wants X, so' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' I should read the file.' } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is the answer.' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Here is the answer.', session_id: 's1' });
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

test('thinking is reported as itself, not as the answer', async () => {
  await withFakeEngine('claude', THINKING, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));

    // Kept, and kept apart: the reader decides whether to open it, and the answer is
    // never made to carry it. See ADR-037.
    assert.equal(textOf(events), 'Here is the answer.');
    assert.equal(reasoningOf(events), 'The user wants X, so I should read the file.');
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

/**
 * Reproduces an interactive permission ask, recorded from the real CLI running
 * with `--permission-prompt-tool stdio`.
 *
 * Unlike every fake above, this one answers lines as they arrive rather than
 * waiting for stdin to close: the whole point of the mode is that the process is
 * still listening while it waits for a decision.
 */
const ASKING = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
let asked = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    if (message.type === 'user' && !asked) {
      asked = true;
      out({ type: 'control_request', request_id: 'req-1', request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Bash',
        input: { command: 'curl -s https://example.com', description: 'Fetch example.com' },
        description: 'Fetch example.com',
        decision_reason: 'This command requires approval',
        permission_suggestions: [{
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'curl *' }],
        }, {
          type: 'addRules',
          behavior: 'deny',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash', ruleContent: 'rm *' }],
        }],
      } });
      continue;
    }
    if (message.type === 'control_response') {
      const behavior = message.response && message.response.response
        ? message.response.response.behavior
        : 'missing';
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'behavior=' + behavior } } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1' });
      process.exit(0);
    }
  }
});
`;

/** Reports its argv and the prompt it was handed, without waiting for stdin to close. */
const ASKING_ARGS = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop();
  for (const line of lines) {
    if (line.trim() === '') continue;
    const payload = JSON.stringify({ args: process.argv.slice(2), input: line });
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: payload } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1' });
    process.exit(0);
  }
});
`;

test('an allowed ask lets the call through', async () => {
  await withFakeEngine('claude', ASKING, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', {
        cwd: process.cwd(),
        requestPermission: async () => 'once',
      }),
    );

    assert.equal(textOf(events), 'behavior=allow');
    assert.deepEqual(blockedOf(events), []);
  });
});

test('always allows on the wire, because the lasting grant is kept here', async () => {
  await withFakeEngine('claude', ASKING, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', {
        cwd: process.cwd(),
        requestPermission: async () => 'always',
      }),
    );

    // Claude Code has no grant of its own that would outlive this run, so 'always'
    // cannot be forwarded and has to look like 'once' to the engine. See ADR-022.
    assert.equal(textOf(events), 'behavior=allow');
  });
});

test('a rejected ask is refused without being explained here', async () => {
  await withFakeEngine('claude', ASKING, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', {
        cwd: process.cwd(),
        requestPermission: async () => 'reject',
      }),
    );

    assert.equal(textOf(events), 'behavior=deny');

    // Reporting the refusal belongs to whoever refused. Only that level knows
    // whether the user said no, a limit on the machine did, or nobody answered, and
    // guessing here would put a wrong reason in the transcript. See ADR-022.
    assert.deepEqual(blockedOf(events), []);
  });
});

test('a decision that throws refuses the call', async () => {
  await withFakeEngine('claude', ASKING, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hi', {
        cwd: process.cwd(),
        requestPermission: async () => {
          throw new Error('the browser went away');
        },
      }),
    );

    // Running a tool call nobody agreed to is the one outcome worth ruling out.
    assert.equal(textOf(events), 'behavior=deny');
  });
});

test('an ask carries what a person needs in order to decide', async () => {
  await withFakeEngine('claude', ASKING, async () => {
    const asks: EnginePermissionRequest[] = [];

    await collect(
      new ClaudeEngine().prompt('hi', {
        cwd: process.cwd(),
        requestPermission: async (request) => {
          asks.push(request);
          return 'reject';
        },
      }),
    );

    assert.equal(asks.length, 1);
    const ask = asks[0];
    assert.ok(ask !== undefined);
    assert.equal(ask.tool, 'Bash');
    assert.equal(ask.title, 'Bash');
    assert.equal(ask.target, 'curl -s https://example.com');
    assert.equal(ask.reason, 'This command requires approval');
    assert.deepEqual(ask.details, ['Fetch example.com']);
    // Only the allowing suggestion is offered. A suggested deny is not something
    // a tap on "always" should install.
    assert.deepEqual(ask.suggestions, ['Bash(curl *)']);
  });
});

test('asks are routed to this host and the prompt becomes a streaming message', async () => {
  await withFakeEngine('claude', ASKING_ARGS, async () => {
    const events = await collect(
      new ClaudeEngine().prompt('hello there', {
        cwd: process.cwd(),
        requestPermission: async () => 'once',
      }),
    );
    const payload = JSON.parse(textOf(events)) as { args: string[]; input: string };

    // Pinned deliberately. The flag is absent from `claude --help`, and without it
    // every ask silently becomes a refusal instead. See ADR-022.
    const at = payload.args.indexOf('--permission-prompt-tool');
    assert.notEqual(at, -1);
    assert.equal(payload.args[at + 1], 'stdio');

    const format = payload.args.indexOf('--input-format');
    assert.notEqual(format, -1);
    assert.equal(payload.args[format + 1], 'stream-json');

    // stdin still carries the prompt, now wrapped so the same stream can also
    // carry answers back.
    const message = JSON.parse(payload.input) as {
      type: string;
      message: { content: { text: string }[] };
    };
    assert.equal(message.type, 'user');
    assert.equal(message.message.content[0]?.text, 'hello there');
    assert.ok(!payload.args.includes('hello there'));
  });
});

test('nothing is routed here when nobody can answer', async () => {
  await withFakeEngine('claude', ECHO_ARGS, async () => {
    const events = await collect(new ClaudeEngine().prompt('hi', { cwd: process.cwd() }));
    const payload = JSON.parse(textOf(events)) as { args: string[]; input: string };

    // Asking a question no one will hear would stall the turn until it timed out,
    // so the plain path is left exactly as it was.
    assert.ok(!payload.args.includes('--permission-prompt-tool'));
    assert.ok(!payload.args.includes('--input-format'));
    assert.equal(payload.input.trim(), 'hi');
  });
});
