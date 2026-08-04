import { randomUUID } from 'node:crypto';
import { RUN_COMMANDS_RULE } from './antigravity-settings.js';
import { captureOutput, isOnPath } from '../which.js';
import { streamProcess } from '../process.js';
import type { Engine, EngineEvent, PromptOptions } from '../types.js';

const COMMAND = 'agy';

/**
 * A model slug as `agy models` reports it: one bare slug per line, lower case,
 * with at least one separator, such as `gemini-3.1-pro-high`.
 *
 * Matched on the first field rather than the whole line so a version that prints a
 * display name beside the slug still works. Case matters, because a lower-case
 * first field is what tells a slug apart from prose like `Available models:`.
 */
const MODEL_SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

/**
 * Argument keys that describe what a tool acted on, normalised to letters and
 * digits so one list covers every casing convention.
 *
 * Antigravity names its parameters in PascalCase (`CommandLine`), while the shared
 * helper knows the snake_case and camelCase forms the other engines use. Matching
 * on a normalised key keeps that difference inside this adapter.
 */
const TARGET_KEYS = [
  'commandline',
  'command',
  'filepath',
  'absolutepath',
  'targetfile',
  'directorypath',
  'directory',
  'path',
  'pattern',
  'query',
  'url',
  'description',
] as const;

/**
 * How Antigravity words a tool call its policy would not approve.
 *
 * Headless mode cannot ask anyone, so a call that needs approval is denied and the
 * run carries on and still exits 0. Without matching this the turn would show an
 * answer that worked around a refusal nobody ever saw.
 */
const PERMISSION_PATTERN =
  /denied permission|auto-denied|soft-denied|requires approval|not allowed|permissions\.allow/i;

/**
 * The permission a refusal names, as Antigravity words it: `write_file(/path)` for
 * a file, or a sentence about running a command.
 */
const REFUSED_PERMISSION = /permission for (\w+)\(/i;
const REFUSED_COMMAND = /permission to run command/i;

/**
 * Explains a refusal in this project's words, and says what would allow it.
 *
 * Not the engine's words, which report "User denied permission" for a call no user
 * was ever shown. Nobody was asked: headless mode has no prompt, so the policy
 * decided alone. Reporting it as the user's decision would blame them for a refusal
 * they had no part in, and would read as a choice they could make differently in the
 * browser next time, which they cannot.
 *
 * The rule is named because it is the only thing that changes the outcome, and it is
 * scoped to the workspace rather than to the one path that happened to be refused, so
 * granting it once covers the work rather than the first file of it.
 *
 * The engine's own wording is still emitted as the output of the call, so nothing it
 * said is hidden.
 */
function refusalReason(message: string, cwd: string): string {
  const named = REFUSED_PERMISSION.exec(message)?.[1];
  const rule =
    named !== undefined
      ? `${named}(${cwd})`
      : REFUSED_COMMAND.test(message)
        ? // Every command, not the one that was refused: Antigravity matches a
          // command rule as a prefix of the whole command line, and the agent puts
          // its own `cd <dir> &&` in front of the program it means to run.
          RUN_COMMANDS_RULE
        : undefined;

  return [
    'Refused by Antigravity policy, which headless mode cannot ask about.',
    rule === undefined
      ? 'Allow it under permissions.allow in Antigravity settings.'
      : `Grant ${rule} from Setup, under Antigravity access, or add it under permissions.allow in Antigravity settings.`,
  ].join(' ');
}

/** Terminal statuses that mean the caller stopped the run, not that it failed. */
const CANCELLED_STATUSES = new Set(['CANCELED', 'INTERRUPTED']);

interface ToolError {
  type?: unknown;
  message?: unknown;
}

interface ToolInfo {
  name?: unknown;
  parameters?: unknown;
  output?: unknown;
  error?: ToolError;
}

interface StepUpdate {
  conversation_id?: unknown;
  step_index?: unknown;
  state?: unknown;
  step_type?: unknown;
  tool_name?: unknown;
  text_delta?: unknown;
  tool_info?: ToolInfo;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

interface InitPayload {
  permission_mode?: unknown;
}

interface ResultPayload {
  conversation_id?: unknown;
  status?: unknown;
  error?: unknown;
}

interface AgyLine {
  event?: unknown;
  /** Carried on init, where it sits beside the payload rather than inside it. */
  conversation_id?: unknown;
  init?: InitPayload;
  step_update?: StepUpdate;
  result?: ResultPayload;
}

/**
 * Picks the most descriptive argument of a tool call.
 *
 * Returns undefined when nothing recognisable is there, so the activity is shown
 * as the tool name alone rather than as a tool acting on random JSON.
 */
function readTarget(parameters: unknown): string | undefined {
  if (typeof parameters !== 'object' || parameters === null) {
    return undefined;
  }

  const byNormalisedKey = new Map<string, string>();

  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim() !== '') {
      byNormalisedKey.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), value);
    }
  }

  for (const key of TARGET_KEYS) {
    const found = byNormalisedKey.get(key);

    if (found !== undefined) {
      // Put on one line, but never cut: a chained command ends in the part that
      // matters, and this is also what a permission rule is judged against.
      return found.replace(/\s+/g, ' ').trim();
    }
  }

  return undefined;
}

/**
 * Antigravity CLI adapter.
 *
 * `agy -p <prompt> --output-format stream-json` prints one JSON object per line:
 * a single `init`, any number of `step_update`, then exactly one `result`. Text
 * arrives as `text_delta` on `agent_response` steps, tool calls as `tool` steps
 * carrying `tool_info`, and the conversation id on `init`, which is what the next
 * prompt resumes with through `--conversation`.
 *
 * The prompt travels as an argument rather than on stdin, because `-p` is the only
 * way headless mode accepts one. Nothing is quoted or escaped on the way: the
 * process is spawned directly with no shell, and the protocol caps a prompt well
 * below the argument limit.
 *
 * `--dangerously-skip-permissions` is deliberately never passed. It would approve
 * every tool call, including file writes and shell commands, which is exactly what
 * the limits set on this machine exist to prevent. Left off, Antigravity applies
 * its own policy and soft-denies what it cannot approve. See ADR-031.
 */
export class AntigravityEngine implements Engine {
  readonly name = 'antigravity';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /** Reads the model list from `agy models`, one `slug display name` per line. */
  async listModels(): Promise<string[]> {
    const output = await captureOutput(COMMAND, ['models']);

    if (output === undefined) {
      return [];
    }

    const slugs: string[] = [];

    for (const line of output.split('\n')) {
      const slug = line.trim().split(/\s+/)[0] ?? '';

      if (MODEL_SLUG.test(slug) && !slugs.includes(slug)) {
        slugs.push(slug);
      }
    }

    return slugs;
  }

  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    return this.run(text, options);
  }

  /**
   * Runs the prompt, retrying once without the conversation id when resuming
   * produced nothing.
   *
   * A stale id is expected rather than exceptional: conversations live in
   * Antigravity's own store and can be pruned at any time. Answering without the
   * earlier context is better than refusing to answer at all.
   */
  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    if (options.resume !== undefined) {
      const buffered: EngineEvent[] = [];
      let committed = false;
      let failed = false;

      for await (const event of this.attempt(text, options, options.resume)) {
        // Anything the engine produced means the conversation was found, so from
        // here on the run is passed straight through. A session event counts: a
        // refused resume never reports an id.
        if (event.type !== 'log' && event.type !== 'done' && event.type !== 'error') {
          committed = true;
        }

        if (!committed && event.type === 'error') {
          failed = true;
          continue;
        }

        // A failure caused by the missing conversation is not worth reporting when
        // the retry is about to answer properly.
        if (failed && event.type === 'done') {
          continue;
        }

        if (committed) {
          yield* buffered.splice(0, buffered.length);
          yield event;
          continue;
        }

        buffered.push(event);
      }

      if (!failed) {
        yield* buffered;
        return;
      }
    }

    yield* this.attempt(text, options, undefined);
  }

  /** One engine run, with or without a conversation to continue. */
  private async *attempt(
    text: string,
    options: PromptOptions,
    resume: string | undefined,
  ): AsyncGenerator<EngineEvent> {
    const reportedTools = new Set<number>();
    const reportedOutputs = new Set<number>();
    const reportedFailures = new Set<number>();
    let sessionReported = false;
    let totalInput = 0;
    let totalOutput = 0;

    /**
     * Identifies a tool call.
     *
     * Antigravity numbers its steps within a conversation and starts again from zero
     * on the next turn, while an activity id is stored as a key of its own and has
     * to be unique across every conversation on this machine. The other two engines
     * report an id that is already unique; here one has to be made, so the step
     * number is qualified by a token minted per run.
     */
    const runToken = randomUUID();
    const activityId = (index: number): string => `${runToken}:${String(index)}`;
    const mapLine = (line: string): EngineEvent | EngineEvent[] | undefined => {
      if (line.trim() === '') {
        return undefined;
      }

      let parsed: AgyLine;
      try {
        parsed = JSON.parse(line) as AgyLine;
      } catch {
        return undefined;
      }

      if (parsed.event === 'init') {
        // Reported before any answer, so a run cut short still leaves an id to
        // continue from.
        const id = typeof parsed.conversation_id === 'string' ? parsed.conversation_id : '';

        if (id === '' || sessionReported) {
          return undefined;
        }

        sessionReported = true;
        return { type: 'session', id };
      }

      if (parsed.event === 'result') {
        const result = parsed.result ?? {};
        const status = typeof result.status === 'string' ? result.status : '';

        if (status === 'SUCCESS' || CANCELLED_STATUSES.has(status)) {
          return undefined;
        }

        // Every non-terminal status is a run that did not answer, and the reason
        // only ever appears here: the exit code says nothing beyond nonzero.
        const message = typeof result.error === 'string' && result.error !== '' ? result.error : '';

        return {
          type: 'error',
          message:
            message === '' ? `Antigravity ended with status ${status || 'unknown'}.` : message,
        };
      }

      if (parsed.event !== 'step_update' || parsed.step_update === undefined) {
        return undefined;
      }

      const step = parsed.step_update;
      const index = typeof step.step_index === 'number' ? step.step_index : -1;

      if (index < 0) {
        return undefined;
      }

      const events: EngineEvent[] = [];

      // Accumulate token usage from steps that report it.
      const usage = step.usage;
      if (
        usage !== undefined &&
        typeof usage.input_tokens === 'number' &&
        typeof usage.output_tokens === 'number'
      ) {
        totalInput += usage.input_tokens;
        totalOutput += usage.output_tokens;
      }

      // Every fragment is new text, on the DONE as much as on the ACTIVE before
      // it: a recorded answer of "ok\n" arrives as "ok" while the step is active
      // and "\n" as it finishes. Nothing is de-duplicated here, because trimming a
      // fragment against what came before it would drop text whenever the agent
      // repeats itself, and a lone newline is exactly the fragment that repeats.
      if (typeof step.text_delta === 'string' && step.text_delta !== '') {
        events.push({ type: 'delta', text: step.text_delta });
      }

      const info = step.tool_info;
      const tool =
        typeof step.tool_name === 'string' && step.tool_name !== ''
          ? step.tool_name
          : typeof info?.name === 'string' && info.name !== ''
            ? info.name
            : undefined;

      if (tool === undefined) {
        return events.length === 0 ? undefined : events;
      }

      // A step is repeated as the call progresses: ACTIVE first, then DONE, or
      // ERROR when the call was refused or failed. Reported at the first sighting
      // that carries the call, since an ACTIVE step already has its arguments, and
      // reporting one without them would show a tool acting on nothing.
      const settled = step.state === 'DONE' || step.state === 'ERROR';

      if (!reportedTools.has(index) && (settled || info !== undefined)) {
        reportedTools.add(index);
        const target = readTarget(info?.parameters);

        events.push({
          type: 'activity',
          id: activityId(index),
          tool,
          ...(target !== undefined ? { target } : {}),
        });
      }

      const output = info?.output;

      if (typeof output === 'string' && output !== '' && !reportedOutputs.has(index)) {
        reportedOutputs.add(index);
        events.push({ type: 'activity_output', id: activityId(index), output });
      }

      const failure = info?.error;
      const message = typeof failure?.message === 'string' ? failure.message : '';

      if (message !== '' && !reportedFailures.has(index)) {
        reportedFailures.add(index);
        // The engine's own words, kept whole, so what it reported is still readable.
        events.push({ type: 'activity_output', id: activityId(index), output: message });

        // The tool step is the only place a refusal is tied to the call it refused.
        // The notice on stderr describes the run as a whole and names no step, so
        // reporting that too would show the same refusal twice.
        if (PERMISSION_PATTERN.test(message)) {
          events.push({ type: 'blocked', tool, reason: refusalReason(message, options.cwd) });
        }
      }

      return events.length === 0 ? undefined : events;
    };

    // stderr is passed through as a log and never read for refusals. Antigravity
    // prints one notice there summarising the run, which names no step and repeats
    // what the tool step already reported per call.
    yield* streamProcess(
      {
        command: COMMAND,
        args: [
          '-p',
          text,
          '--output-format',
          'stream-json',
          // The workspace has to be named, not just entered. Antigravity keeps its
          // own idea of a workspace and falls back to a scratch directory under
          // ~/.gemini when nothing is added, so a prompt about the project answered
          // that it could not see one while the process was sitting in it.
          '--add-dir',
          options.cwd,
          ...(options.model !== undefined ? ['--model', options.model] : []),
          ...(resume !== undefined ? ['--conversation', resume] : []),
        ],
        cwd: options.cwd,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      mapLine,
    );

    if (totalInput > 0 || totalOutput > 0) {
      yield { type: 'usage', inputTokens: totalInput, outputTokens: totalOutput };
    }
  }
}
