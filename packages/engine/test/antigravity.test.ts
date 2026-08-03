import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityEngine } from '../dist/adapters/antigravity.js';
import type { EngineEvent } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fakes built from output recorded from agy 1.1.9, not from what its reference
 * implies. The two disagree: the reference shows `agy models` printing a display
 * name beside each slug and a DONE step repeating the whole answer, and the real
 * CLI does neither.
 *
 * A stream is one `init`, any number of `step_update`, then exactly one `result`,
 * with the conversation id beside the payload on init and inside it everywhere else.
 */

/**
 * A recorded answer of "ok\n".
 *
 * Every fragment is new text: the ACTIVE step carries "ok" and the DONE that
 * follows carries "\n". A DONE never repeats what came before it.
 */
const STREAMING = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const id = '97b12807-37dd-4b16-9c5c-3350e57757f9';
out({ event: 'init', conversation_id: id, init: { cwd: '/tmp', tools: ['ask_permission', 'run_command'], permission_mode: 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 1, state: 'DONE', step_type: 'unknown', duration_seconds: 0.000607 } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '\\n', duration_seconds: 1.717089 } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.69544 } });
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'ok\\n', num_turns: 1 } });
process.exit(0);
`;

/**
 * Tool steps recorded from a run that listed a directory and then tried to run a
 * shell command.
 *
 * A call is announced ACTIVE with its arguments already present, then settles as
 * DONE or as ERROR. Antigravity names its parameters in PascalCase, and not always
 * the same one: a directory arrives as DirectoryPath and a command as CommandLine.
 */
const TOOL_USE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const id = 'edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3';
out({ event: 'init', conversation_id: id, init: { cwd: '/tmp', tools: [], permission_mode: 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 8, state: 'ACTIVE', step_type: 'tool', tool_name: 'list_dir', tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/tmp/scratch' } } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 8, state: 'DONE', step_type: 'tool', tool_name: 'list_dir', duration_seconds: 0.2, tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/tmp/scratch' }, output: 'note.txt\\n' } } });
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Done.', num_turns: 1 } });
process.exit(0);
`;

/**
 * A run on a thinking model, recorded from agy 1.1.9 with gemini-3.1-pro-high.
 *
 * The model demonstrably reasoned: the steps report 270, 39 and 726 thinking tokens.
 * None of them carries a word of it. An `agent_response` that only thought and then
 * reached for a tool has no `text_delta` at all, and the answer arrives on the last
 * one. Antigravity counts the deliberation and never streams it, which is why this
 * adapter reports no reasoning. See ADR-037.
 */
const THINKING_MODEL = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const id = '0faf6cd6-9bfa-4041-ae81-ac27d09f5fa7';
out({ event: 'init', conversation_id: id, init: { model: 'gemini-3.1-pro-high', cwd: '/tmp', tools: [], permission_mode: 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'DONE', step_type: 'user_input' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 2, state: 'DONE', step_type: 'agent_response', duration_seconds: 3.1, usage: { input_tokens: 18122, output_tokens: 317, thinking_tokens: 270, total_tokens: 18439 } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/scratch/note.txt' } } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 3, state: 'DONE', step_type: 'tool', tool_name: 'view_file', duration_seconds: 0.1, tool_info: { name: 'view_file', parameters: { AbsolutePath: '/tmp/scratch/note.txt' }, output: 'the number is 4271\\n' } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 4, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.4, usage: { input_tokens: 113, output_tokens: 4, thinking_tokens: 0, total_tokens: 117 } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 5, state: 'DONE', step_type: 'agent_response', text_delta: '4271\\n', duration_seconds: 2.2, usage: { input_tokens: 18891, output_tokens: 730, thinking_tokens: 726, total_tokens: 19621 } } });
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '4271\\n', num_turns: 1 } });
process.exit(0);
`;

/** An error envelope, which reports an empty conversation id. */
const FAILURE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'model does-not-exist-model is not recognized' } });
process.exit(1);
`;

/**
 * A recorded refusal. Headless mode cannot prompt, so the call is auto-denied: the
 * step settles as ERROR carrying the reason, the run still exits 0 with SUCCESS,
 * and a notice explaining how to allow it goes to stderr.
 */
const WRITE_DENIED = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const id = 'bb22';
out({ event: 'init', conversation_id: id, init: { cwd: '/tmp', tools: [], permission_mode: 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 5, state: 'ERROR', step_type: 'tool', tool_name: 'replace_file_content', tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/tmp/ws/target.txt' }, error: { type: 'TOOL_ERROR', message: 'User denied permission for write_file(/private/tmp/ws/target.txt).' } } } });
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', num_turns: 1 } });
process.exit(0);
`;

const SOFT_DENIED = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const id = 'aa11';
out({ event: 'init', conversation_id: id, init: { cwd: '/tmp', tools: [], permission_mode: 'request-review' } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 12, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo probe123' } } } });
out({ event: 'step_update', step_update: { conversation_id: id, step_index: 12, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.085332, tool_info: { name: 'run_command', parameters: { CommandLine: 'echo probe123' }, error: { type: 'TOOL_ERROR', message: 'User denied permission to run command:\\necho probe123' } } } });
process.stderr.write('jetski: no output produced \\u2014 a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).\\n');
out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: '', num_turns: 1 } });
process.exit(0);
`;

const ECHO_ARGS = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'x', init: {} }) + '\\n');
process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'x', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: JSON.stringify(args) } }) + '\\n');
process.stdout.write(JSON.stringify({ event: 'result', result: { conversation_id: 'x', status: 'SUCCESS' } }) + '\\n');
process.exit(0);
`;

/**
 * `agy models` as 1.1.9 prints it: one bare slug per line on stdout, with no
 * display name beside it.
 */
const MODELS = `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('gemini-3.6-flash-high\\n');
  process.stdout.write('gemini-3.6-flash-medium\\n');
  process.stdout.write('gemini-3.1-pro-high\\n');
  process.stdout.write('claude-sonnet-4-6\\n');
  process.stdout.write('gpt-oss-120b-medium\\n');
  process.exit(0);
}
process.exit(0);
`;

/** A version that prints a display name beside the slug, which the docs describe. */
const MODELS_WITH_NAMES = `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('Available models:\\n');
  process.stdout.write('gemini-3.1-pro-high Gemini 3.1 Pro (High)\\n');
  process.stdout.write('claude-sonnet-4-6 Claude Sonnet 4.6 (Thinking)\\n');
  process.exit(0);
}
process.exit(0);
`;

/** A conversation that no longer exists, which is refused before anything runs. */
const STALE_CONVERSATION = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const args = process.argv.slice(2);
if (args.includes('--conversation')) {
  out({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'conversation not found' } });
  process.exit(1);
}
out({ event: 'init', conversation_id: 'fresh', init: {} });
out({ event: 'step_update', step_update: { conversation_id: 'fresh', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Answered anyway.' } });
out({ event: 'result', result: { conversation_id: 'fresh', status: 'SUCCESS' } });
process.exit(0);
`;

async function collect(script: string, options: { model?: string; resume?: string } = {}) {
  return withEmptyPath(async () =>
    withFakeEngine('agy', script, async () => {
      const events: EngineEvent[] = [];

      for await (const event of new AntigravityEngine().prompt('hello', {
        cwd: process.cwd(),
        ...options,
      })) {
        events.push(event);
      }

      return events;
    }),
  );
}

const textOf = (events: EngineEvent[]): string =>
  events
    .filter((event) => event.type === 'delta')
    .map((event) => (event.type === 'delta' ? event.text : ''))
    .join('');

test('every text fragment is kept, including the one the DONE carries', async () => {
  const events = await collect(STREAMING);

  // "ok" arrives while the step is active and "\n" as it finishes, so the answer
  // is only whole if both are emitted. Trimming the second against the first would
  // silently drop it, and a lone newline is the fragment that repeats most.
  assert.equal(textOf(events), 'ok\n');
});

test('the conversation id is reported so the next prompt can continue it', async () => {
  const events = await collect(STREAMING);
  const session = events.find((event) => event.type === 'session');

  // Read from init, which is where it appears beside the payload rather than
  // inside it, so a run cut short still leaves an id.
  assert.deepEqual(session, { type: 'session', id: '97b12807-37dd-4b16-9c5c-3350e57757f9' });
});

test('a thinking model reports its work but never its thinking', async () => {
  const events = await collect(THINKING_MODEL);

  // The recorded run spent 726 thinking tokens on its last step, so the model did
  // reason. Antigravity reports the count and never the words, and an adapter is
  // pinned to what the engine actually sends: there is nothing here to fold, and a
  // reasoning event invented for it would be one no recording could support.
  // See ADR-037.
  assert.equal(
    events.some((event) => event.type === 'reasoning'),
    false,
  );

  // What it did is reported in full, which is what the running turn is named from.
  // See ADR-038.
  const activities = events.filter((event) => event.type === 'activity');
  assert.deepEqual(
    activities.map((event) => (event.type === 'activity' ? event.tool : '')),
    ['view_file'],
  );

  // An agent_response that only thought carries no text at all, so the answer is
  // whatever the steps that do carry some report.
  assert.equal(textOf(events), '4271\n');
});

test('a tool call is reported once, with what it acted on', async () => {
  const events = await collect(TOOL_USE);
  const activities = events.filter((event) => event.type === 'activity');

  // The step is repeated as the call progresses, so it is reported at its first
  // sighting and never again. DirectoryPath is read for the same reason
  // CommandLine is: the parameter naming a directory is not the one naming a file.
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.type === 'activity' ? activities[0].tool : '', 'list_dir');
  assert.equal(activities[0]?.type === 'activity' ? activities[0].target : '', '/tmp/scratch');
});

test('tool output is reported against the call it belongs to', async () => {
  const events = await collect(TOOL_USE);
  const activity = events.find((event) => event.type === 'activity');
  const outputs = events.filter((event) => event.type === 'activity_output');

  // Once, even though the parameters appear on both the ACTIVE and the DONE, and
  // under the same id as the call so the output lands on the right activity.
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.type === 'activity_output' ? outputs[0].output : '', 'note.txt\n');
  assert.equal(
    outputs[0]?.type === 'activity_output' ? outputs[0].id : '',
    activity?.type === 'activity' ? activity.id : 'x',
  );
});

test('two runs never reuse an activity id', async () => {
  const first = await collect(TOOL_USE);
  const second = await collect(TOOL_USE);

  const ids = (events: EngineEvent[]): string[] =>
    events
      .filter((event) => event.type === 'activity')
      .map((event) => (event as { id: string }).id);

  // The step number restarts at zero every turn, while an activity is stored under
  // an id of its own that has to be unique across every conversation. Reusing it
  // failed the insert, and the uncaught error took the whole server down.
  const reused = ids(first).filter((id) => ids(second).includes(id));
  assert.deepEqual(reused, [], 'an id from the first run came back in the second');
});

test('a refused tool call is reported as blocked exactly once', async () => {
  const events = await collect(SOFT_DENIED);
  const blocked = events.filter((event) => event.type === 'blocked');

  // The tool step reports the refusal per call, and a notice on stderr repeats it
  // for the run as a whole. Reading both showed one refusal as two, the second of
  // them attributed to a tool the notice never named.
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.type === 'blocked' ? blocked[0].tool : '', 'run_command');
});

test('a refusal nobody was asked about is not blamed on the user', async () => {
  const events = await collect(SOFT_DENIED);
  const blocked = events.find((event) => event.type === 'blocked');
  const reason = blocked?.type === 'blocked' ? blocked.reason : '';

  // Antigravity words it "User denied permission" for a call no user was shown.
  // Nobody was asked, because headless mode has no prompt, so saying the user
  // decided would blame them for a refusal they had no part in and imply a choice
  // they could make differently in the browser, which they cannot.
  assert.doesNotMatch(reason, /user/i);
  assert.match(reason, /permissions\.allow/);
  // The rule is the only thing that changes the outcome, so it is named.
  assert.match(reason, /command\(/);

  // What the engine actually said is still readable as the output of the call.
  const outputs = events
    .filter((event) => event.type === 'activity_output')
    .map((event) => (event.type === 'activity_output' ? event.output : ''));

  assert.ok(
    outputs.some((output) => output.includes('User denied permission')),
    "the engine's own wording should still be kept as the output",
  );
});

test('a refused write names a rule covering the workspace, not the one file', async () => {
  const events = await collect(WRITE_DENIED);
  const blocked = events.find((event) => event.type === 'blocked');
  const reason = blocked?.type === 'blocked' ? blocked.reason : '';

  // Scoped to the workspace rather than to the path that happened to be refused
  // first, so granting it once covers the work instead of one file of it.
  assert.match(reason, /write_file\(/);
  assert.ok(
    reason.includes(process.cwd()),
    'the rule should cover the workspace the engine was run in',
  );
});

test('a step that settles as ERROR still reports the call it made', async () => {
  const events = await collect(SOFT_DENIED);
  const activities = events.filter((event) => event.type === 'activity');

  // A refused call settles as ERROR rather than DONE, which is a state the
  // reference does not mention at all.
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.type === 'activity' ? activities[0].tool : '', 'run_command');
  assert.equal(activities[0]?.type === 'activity' ? activities[0].target : '', 'echo probe123');
});

test('a failing status is reported with the reason it gave', async () => {
  const events = await collect(FAILURE);
  const error = events.find((event) => event.type === 'error');

  // The exit code says nothing beyond nonzero, so the result envelope is the only
  // place the reason exists.
  assert.equal(
    error?.type === 'error' ? error.message : '',
    'model does-not-exist-model is not recognized',
  );
});

test('permissions are never skipped', async () => {
  const events = await collect(ECHO_ARGS);
  const args = JSON.parse(textOf(events)) as string[];

  // --dangerously-skip-permissions would approve every tool call, including file
  // writes and shell commands, which is what the limits on this machine exist to
  // prevent. See ADR-031.
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(args.slice(0, 4), ['-p', 'hello', '--output-format', 'stream-json']);
});

test('the workspace is named, not just entered', async () => {
  const events = await collect(ECHO_ARGS);
  const args = JSON.parse(textOf(events)) as string[];

  // Antigravity keeps its own idea of a workspace and falls back to a scratch
  // directory under ~/.gemini when nothing is added, so running the process in the
  // workspace is not enough: without this the agent answers that it cannot see any
  // project while sitting inside one.
  assert.ok(args.includes('--add-dir'));
  assert.equal(args[args.indexOf('--add-dir') + 1], process.cwd());
});

test('the model is pinned by slug', async () => {
  const events = await collect(ECHO_ARGS, { model: 'gemini-3.1-pro-high' });
  const args = JSON.parse(textOf(events)) as string[];

  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.1-pro-high');
});

test('models are read from the bare slugs agy prints', async () => {
  const models = await withEmptyPath(async () =>
    withFakeEngine('agy', MODELS, async () => new AntigravityEngine().listModels()),
  );

  // One slug per line and nothing else, which is what 1.1.9 prints. Expecting a
  // display name beside it matched no line at all, which left the browser offering
  // nothing but the engine default.
  assert.deepEqual(models, [
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-medium',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
  ]);
});

test('a display name beside the slug is tolerated, and prose is not read as one', async () => {
  const models = await withEmptyPath(async () =>
    withFakeEngine('agy', MODELS_WITH_NAMES, async () => new AntigravityEngine().listModels()),
  );

  // Headless mode refuses an unknown --model instead of falling back, so only the
  // slug is usable. A heading is not a model, which is what the lower-case rule
  // separates it from.
  assert.deepEqual(models, ['gemini-3.1-pro-high', 'claude-sonnet-4-6']);
});

test('a conversation that no longer exists is answered without it', async () => {
  const events = await collect(STALE_CONVERSATION, { resume: 'gone' });

  // Conversations live in Antigravity's own store and can be pruned at any time.
  // Answering without the earlier context beats not answering.
  assert.equal(textOf(events), 'Answered anyway.');
  assert.equal(
    events.filter((event) => event.type === 'error').length,
    0,
    'the refused resume should not be reported as a failure',
  );
});
