import { isOnPath } from '../which.js';
import { streamProcess } from '../process.js';
import { readActivityTarget } from '../activity.js';
import type { Engine, EngineEvent, PromptOptions } from '../types.js';

const COMMAND = 'claude';

/**
 * Aliases the --model flag accepts. Claude Code exposes no way to enumerate
 * models, so the aliases are the only stable choice to offer.
 */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

interface ContentBlockDelta {
  type?: unknown;
  text?: unknown;
}

interface StreamEvent {
  type?: unknown;
  delta?: ContentBlockDelta;
  content_block?: ContentBlockDelta;
}

interface ContentBlock {
  type?: unknown;
  name?: unknown;
  input?: unknown;
}

interface AssistantMessage {
  content?: unknown;
}

interface ClaudeLine {
  type?: unknown;
  subtype?: unknown;
  event?: StreamEvent;
  message?: AssistantMessage;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
}

/**
 * How Claude Code reports a session id it cannot find.
 *
 * The failure is only spelled out on stderr; the result line carries a generic
 * error, so this is the only way to tell a stale id from a real failure.
 */
const STALE_SESSION_PATTERN = /no conversation found/i;

/**
 * Claude Code adapter.
 *
 * `claude -p --output-format stream-json --verbose --include-partial-messages`
 * prints one JSON object per line. Text arrives as content_block_delta events
 * that already contain only the new fragment, so no de-duplication is needed
 * here. The final `result` line reports failures that never reach stderr.
 *
 * Tool calls are read from the `assistant` lines rather than from the stream
 * events. A tool call is announced before its arguments exist, which then arrive
 * split across input_json_delta fragments; the assistant line carries the same
 * call with its arguments already assembled.
 *
 * The session id is read from the `result` line for the same reason: resuming
 * makes the hook lines report a different id, and storing that one would break
 * the next resume.
 */
export class ClaudeEngine implements Engine {
  readonly name = 'claude';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Claude Code has no command that lists models, only the aliases its --model
   * flag accepts. Those are returned so the UI can still offer a choice.
   */
  async listModels(): Promise<string[]> {
    return (await isOnPath(COMMAND)) ? [...MODEL_ALIASES] : [];
  }

  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    return this.run(text, options);
  }

  /**
   * Runs the prompt, retrying once without the session id when Claude Code cannot
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
        if (event.type === 'delta' || event.type === 'activity' || event.type === 'session') {
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
    const mapLine = (line: string): EngineEvent | EngineEvent[] | undefined => {
      if (line.trim() === '') {
        return undefined;
      }

      let parsed: ClaudeLine;
      try {
        parsed = JSON.parse(line) as ClaudeLine;
      } catch {
        return undefined;
      }

      if (parsed.type === 'result') {
        if (parsed.is_error === true) {
          const message =
            typeof parsed.result === 'string' ? parsed.result : 'Engine reported an error.';
          return { type: 'error', message };
        }

        // Read from the result line rather than the first line carrying an id.
        // Resuming makes hook lines report a different id, and storing that one
        // would break the next resume.
        return typeof parsed.session_id === 'string' && parsed.session_id !== ''
          ? { type: 'session', id: parsed.session_id }
          : undefined;
      }

      // One assistant message can carry several tool calls, so every block that
      // is one becomes its own activity.
      if (parsed.type === 'assistant') {
        const content = parsed.message?.content;

        if (!Array.isArray(content)) {
          return undefined;
        }

        const activities: EngineEvent[] = [];

        for (const block of content as ContentBlock[]) {
          if (block.type !== 'tool_use' || typeof block.name !== 'string' || block.name === '') {
            continue;
          }

          const target = readActivityTarget(block.input);

          activities.push({
            type: 'activity',
            tool: block.name,
            ...(target !== undefined ? { target } : {}),
          });
        }

        return activities.length === 0 ? undefined : activities;
      }

      if (parsed.type !== 'stream_event') {
        return undefined;
      }

      const event = parsed.event;
      if (event?.type !== 'content_block_delta') {
        return undefined;
      }

      const delta = event.delta;
      if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') {
        return undefined;
      }

      return { type: 'delta', text: delta.text };
    };

    return streamProcess(
      {
        command: COMMAND,
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          ...(options.model !== undefined ? ['--model', options.model] : []),
          ...(resume !== undefined ? ['--resume', resume] : []),
        ],
        cwd: options.cwd,
        input: text,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      mapLine,
    );
  }
}
