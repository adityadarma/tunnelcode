import { captureOutput, isOnPath } from '../which.js';
import { streamProcess } from '../process.js';
import { readActivityTarget } from '../activity.js';
import type { Engine, EngineEvent, PromptOptions } from '../types.js';

const COMMAND = 'opencode';

/** A model id looks like provider/model, which is what opencode run -m expects. */
const MODEL_PATTERN = /^[\w.-]+\/[\w./-]+$/;

/**
 * Title given to a session the adapter starts.
 *
 * A new session without a title makes opencode name it from the prompt, and the
 * generated name arrives as the only text of the run: no tool is ever called and
 * the answer never appears. Supplying one keeps the run to the actual work. The
 * value is never shown to the user, since the conversation carries its own title.
 */
const SESSION_TITLE = 'tunnelcode';

interface TextPart {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  /** Tool name, present on tool parts rather than text parts. */
  tool?: unknown;
  /**
   * Identifies one call. Tool parts carry this instead of an id, so two calls to
   * the same tool stay distinguishable.
   */
  callID?: unknown;
  /** Call details, where the arguments live once the call is running. */
  state?: { input?: unknown; status?: unknown; error?: unknown } | undefined;
}

interface OpenCodeLine {
  type?: unknown;
  part?: TextPart;
  /** Present on every event, naming the session the run belongs to. */
  sessionID?: unknown;
}

/**
 * How opencode reports a session id it cannot find.
 *
 * Only said on stderr; the process exits nonzero without printing any event, so
 * this is the only way to tell a stale id from a real failure.
 */
const STALE_SESSION_PATTERN = /session not found/i;

/**
 * How opencode words a tool call it refused on permission grounds.
 *
 * A failed call carries a plain error string, and a tool that simply exited
 * nonzero looks the same, so the wording is what separates "not allowed" from
 * "did not work", which the user does not need reported.
 */
const PERMISSION_PATTERN = /rejected permission|permission requested|requires approval/i;

/** Keeps a refusal short enough to read as one line in a conversation. */
const REASON_MAX_LENGTH = 200;

function shortenReason(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= REASON_MAX_LENGTH ? flat : `${flat.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

/**
 * OpenCode adapter.
 *
 * `opencode run --format json` prints one JSON event per line. Text events
 * carry the full text of a part rather than just the newest fragment, so the
 * adapter remembers what it already emitted per part and yields only the
 * suffix. Without that the browser would show the answer repeated.
 *
 * Tool parts are mapped to activities. The line announcing one is `tool_use`
 * while the part inside it is `tool`, and the call is identified by callID rather
 * than by an id, so both are handled here.
 *
 * The session id is read from `sessionID`, which every event carries and which
 * keeps its value across a resume, so the first line to report one wins.
 */
export class OpenCodeEngine implements Engine {
  readonly name = 'opencode';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Reads the model list from `opencode models`, one id per line.
   */
  async listModels(): Promise<string[]> {
    const output = await captureOutput(COMMAND, ['models']);

    if (output === undefined) {
      return [];
    }

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => MODEL_PATTERN.test(line));
  }

  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    return this.run(text, options);
  }

  /**
   * Runs the prompt, retrying once without the session id when opencode cannot
   * find it.
   *
   * A stale id is expected rather than exceptional: engine sessions are stored
   * outside this project and can be pruned at any time. Answering without the
   * earlier context is far better than refusing to answer at all.
   */
  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    if (options.resume !== undefined) {
      const attempt: EngineEvent[] = [];
      let stale = false;
      let committed = false;

      for await (const event of this.attempt(text, options, options.resume)) {
        // Anything the engine actually produced means the session was found, so
        // from here on the run is passed straight through.
        if (
          event.type === 'delta' ||
          event.type === 'activity' ||
          event.type === 'blocked' ||
          event.type === 'session'
        ) {
          committed = true;
        }

        if (!committed && event.type === 'log' && STALE_SESSION_PATTERN.test(event.text)) {
          stale = true;
          continue;
        }

        // A failure caused by the missing session is not worth reporting when the
        // retry is about to answer properly.
        if (stale && (event.type === 'error' || event.type === 'done')) {
          continue;
        }

        if (committed) {
          yield* attempt.splice(0, attempt.length);
          yield event;
          continue;
        }

        attempt.push(event);
      }

      if (!stale) {
        yield* attempt;
        return;
      }
    }

    yield* this.attempt(text, options, undefined);
  }

  /** One engine run, with or without a session to continue. */
  private attempt(
    text: string,
    options: PromptOptions,
    resume: string | undefined,
  ): AsyncGenerator<EngineEvent> {
    const emitted = new Map<string, string>();
    const reportedTools = new Set<string>();
    // Tracked apart from reportedTools: a call is announced once but its refusal
    // arrives later, on a repeat of the same part.
    const reportedRefusals = new Set<string>();
    let reportedSession = false;

    const mapEvent = (parsed: OpenCodeLine): EngineEvent | EngineEvent[] | undefined => {
      // The line is `tool_use` while the part inside it is `tool`. Matching the
      // part shape alone would also catch a line type that is not a tool call.
      if (parsed.type === 'tool_use' || parsed.type === 'tool') {
        const part = parsed.part;

        if (part === undefined || typeof part.tool !== 'string' || part.tool === '') {
          return undefined;
        }

        // callID comes first because tool parts carry no id, and falling back to
        // the tool name would merge two calls to the same tool into one.
        const id =
          typeof part.callID === 'string'
            ? part.callID
            : typeof part.id === 'string'
              ? part.id
              : part.tool;

        const events: EngineEvent[] = [];

        // A tool part is repeated as its call progresses, so it is reported once
        // per call.
        if (!reportedTools.has(id)) {
          reportedTools.add(id);

          const target = readActivityTarget(part.state?.input);

          events.push({
            type: 'activity',
            tool: part.tool,
            ...(target !== undefined ? { target } : {}),
          });
        }

        // Checked separately from the activity above, because a refusal usually
        // arrives on a repeat of a part already reported, which the dedupe above
        // would otherwise swallow.
        const error = part.state?.error;

        if (
          typeof error === 'string' &&
          PERMISSION_PATTERN.test(error) &&
          !reportedRefusals.has(id)
        ) {
          reportedRefusals.add(id);
          events.push({ type: 'blocked', tool: part.tool, reason: shortenReason(error) });
        }

        return events.length === 0 ? undefined : events;
      }

      if (parsed.type !== 'text') {
        return undefined;
      }

      const part = parsed.part;
      if (part === undefined || part.type !== 'text' || typeof part.text !== 'string') {
        return undefined;
      }

      const id = typeof part.id === 'string' ? part.id : 'default';
      const previous = emitted.get(id) ?? '';
      emitted.set(id, part.text);

      const fragment = part.text.startsWith(previous)
        ? part.text.slice(previous.length)
        : part.text;

      return fragment === '' ? undefined : { type: 'delta', text: fragment };
    };

    const mapLine = (line: string): EngineEvent | EngineEvent[] | undefined => {
      if (line.trim() === '') {
        return undefined;
      }

      let parsed: OpenCodeLine;
      try {
        parsed = JSON.parse(line) as OpenCodeLine;
      } catch {
        return undefined;
      }

      const event = mapEvent(parsed);

      // Every event names its session and the id stays the same across a resume,
      // so the first line carrying one is enough. Emitted before the line's own
      // event, so a run cut short halfway still leaves an id to continue from.
      if (!reportedSession && typeof parsed.sessionID === 'string' && parsed.sessionID !== '') {
        reportedSession = true;
        const session: EngineEvent = { type: 'session', id: parsed.sessionID };

        // One line can now map to several events, so the session is prepended to
        // whatever came back rather than assuming a single event.
        if (event === undefined) {
          return session;
        }

        return [session, ...(Array.isArray(event) ? event : [event])];
      }

      return event;
    };

    return streamProcess(
      {
        command: COMMAND,
        args: [
          'run',
          '--format',
          'json',
          ...(options.model !== undefined ? ['--model', options.model] : []),
          // Only a new session needs naming. A resumed one already has a title,
          // and it is not this adapter's business to rename it.
          ...(resume !== undefined ? ['--session', resume] : ['--title', SESSION_TITLE]),
        ],
        cwd: options.cwd,
        input: text,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      mapLine,
    );
  }
}
