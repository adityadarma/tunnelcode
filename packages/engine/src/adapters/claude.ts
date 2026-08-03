import { isOnPath } from '../which.js';
import { streamProcess } from '../process.js';
import type { ProcessChannel } from '../process.js';
import { readActivityTarget } from '../activity.js';
import type {
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'claude';

/**
 * Routes permission prompts to this process instead of letting Claude Code
 * decide alone.
 *
 * Undocumented in `claude --help`, and load-bearing: without it a call that needs
 * approval comes back as a failed tool result and nobody is ever asked. The
 * adapter tests pin the flag so its removal fails loudly rather than quietly
 * turning every ask into a refusal. See ADR-022.
 */
const PERMISSION_PROMPT_TOOL = 'stdio';

/**
 * Told to the engine when an ask is refused.
 *
 * Deliberately worded so it does not read as "needs approval": matching the
 * auto-deny wording would make the refusal detection below report it as well.
 */
const REJECTED_MESSAGE = 'The user rejected this tool call.';

/**
 * Aliases the --model flag accepts. Claude Code exposes no way to enumerate
 * models, so the aliases are the only stable choice to offer.
 */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

interface ContentBlockDelta {
  type?: unknown;
  text?: unknown;
  /**
   * Carried by a thinking_delta, which names its field after itself rather than
   * calling it text like an answer does.
   */
  thinking?: unknown;
}

interface StreamEvent {
  type?: unknown;
  delta?: ContentBlockDelta;
  content_block?: ContentBlockDelta;
}

interface ContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  /** Set on a tool_result, naming the tool_use it answers. */
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

/** Carried by assistant lines and by the user lines that report tool results. */
interface LineMessage {
  content?: unknown;
}

/** The ask itself, carried by a control_request line. */
interface ControlRequest {
  subtype?: unknown;
  tool_name?: unknown;
  display_name?: unknown;
  description?: unknown;
  input?: unknown;
  decision_reason?: unknown;
  permission_suggestions?: unknown;
}

interface ClaudeLine {
  type?: unknown;
  subtype?: unknown;
  event?: StreamEvent;
  message?: LineMessage;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  request_id?: unknown;
  request?: ControlRequest;
}

/**
 * How Claude Code reports a session id it cannot find.
 *
 * The failure is only spelled out on stderr; the result line carries a generic
 * error, so this is the only way to tell a stale id from a real failure.
 */
const STALE_SESSION_PATTERN = /no conversation found/i;

/**
 * How Claude Code words a tool result it refused on permission grounds.
 *
 * A tool_result only says it is an error, not why, and an ordinary tool failure
 * looks the same. Matching the wording is what separates "not allowed" from
 * "the command exited nonzero", which the user does not need reported.
 */
const PERMISSION_PATTERN = /requested permissions|requires approval|permission to/i;

/** Keeps a refusal short enough to read as one line in a conversation. */
const REASON_MAX_LENGTH = 200;

function shortenReason(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= REASON_MAX_LENGTH ? flat : `${flat.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

/**
 * Reads the text of a tool_result, which is either a plain string or the block
 * array the API also allows.
 */
function readResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return (content as { text?: unknown }[])
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join(' ');
}

/**
 * Reads the rules Claude Code offers as a lasting grant for this call.
 *
 * Only the allowing ones are kept: a suggestion to deny is not something a tap on
 * "always" should install.
 */
function readSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const suggestions: string[] = [];

  for (const entry of value as { behavior?: unknown; rules?: unknown }[]) {
    if (entry.behavior !== 'allow' || !Array.isArray(entry.rules)) {
      continue;
    }

    for (const rule of entry.rules as { toolName?: unknown; ruleContent?: unknown }[]) {
      const tool = typeof rule.toolName === 'string' ? rule.toolName : '';
      const content = typeof rule.ruleContent === 'string' ? rule.ruleContent : '';

      if (tool === '') {
        continue;
      }

      suggestions.push(content === '' ? tool : `${tool}(${content})`);
    }
  }

  return suggestions;
}

/** Turns a can_use_tool control request into the shape the caller answers. */
function readPermissionRequest(id: string, request: ControlRequest): EnginePermissionRequest {
  const tool = typeof request.tool_name === 'string' ? request.tool_name : 'tool';
  const title =
    typeof request.display_name === 'string' && request.display_name !== ''
      ? request.display_name
      : tool;
  const description = typeof request.description === 'string' ? request.description.trim() : '';
  const reason = typeof request.decision_reason === 'string' ? request.decision_reason : '';
  const target = readActivityTarget(request.input);

  return {
    id,
    tool,
    title,
    ...(target !== undefined ? { target } : {}),
    ...(reason !== '' ? { reason: shortenReason(reason) } : {}),
    details: description === '' ? [] : [description],
    suggestions: readSuggestions(request.permission_suggestions),
  };
}

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
    // Tool names by call id. A tool_result says which call it answers but not
    // which tool that was, so the name has to be remembered from the tool_use.
    const toolNames = new Map<string, string>();

    // Whether anyone is able to answer an ask. Nobody is by default, and asking a
    // question no one will hear would only stall the turn.
    const ask = options.requestPermission;
    const interactive = ask !== undefined;

    let channel: ProcessChannel | undefined;

    /**
     * Answers one ask, once the caller has decided.
     *
     * Refusal is the fallback for a caller that throws, because the alternative is
     * running a tool call nobody agreed to.
     */
    const answer = async (id: string, request: ControlRequest): Promise<void> => {
      if (ask === undefined) {
        return;
      }

      let decision: EnginePermissionDecision;

      try {
        decision = await ask(readPermissionRequest(id, request));
      } catch {
        decision = 'reject';
      }

      // 'always' allows on the wire like 'once' does. Claude Code has no lasting
      // grant of its own that would survive this run, so remembering it is the
      // caller's job. See ADR-022.
      const allowed = decision !== 'reject';

      // A refusal is not reported from here. Only the caller knows why it refused,
      // and "the user said no" reads as a lie when the real reason was a limit set
      // on this machine, or nobody answering at all.
      channel?.write(
        JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: id,
            response: allowed
              ? { behavior: 'allow', updatedInput: request.input ?? {} }
              : { behavior: 'deny', message: REJECTED_MESSAGE },
          },
        }),
      );
    };

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

      // An ask. Deciding it means waiting for a person, so the decision is
      // reached outside this mapper and the events it produces are emitted on the
      // channel rather than returned from here.
      if (parsed.type === 'control_request') {
        const request = parsed.request;

        if (
          interactive &&
          request?.subtype === 'can_use_tool' &&
          typeof parsed.request_id === 'string' &&
          parsed.request_id !== ''
        ) {
          void answer(parsed.request_id, request);
        }

        return undefined;
      }

      // Tool results come back on a user line, which is where a refused call is
      // reported. Claude answers around the refusal rather than failing, so this
      // is the only place the user can learn the call never happened.
      if (parsed.type === 'user') {
        const content = parsed.message?.content;

        if (!Array.isArray(content)) {
          return undefined;
        }

        const events: EngineEvent[] = [];

        for (const block of content as ContentBlock[]) {
          if (block.type !== 'tool_result') {
            continue;
          }

          const reason = readResultText(block.content);
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';

          if (id !== '' && reason !== '') {
            events.push({
              type: 'activity_output',
              id,
              output: reason,
            });
          }

          // An ordinary tool failure looks the same as a refusal here, and a
          // command that exited nonzero is the engine's business, not the user's.
          //
          // Only consulted when nobody can be asked. With asks on, a refusal is
          // one this adapter already reported, and reading the wording again would
          // report it twice.
          if (!interactive && block.is_error === true && PERMISSION_PATTERN.test(reason)) {
            events.push({
              type: 'blocked',
              tool: toolNames.get(id) ?? 'tool',
              reason: shortenReason(reason),
            });
          }
        }

        return events.length === 0 ? undefined : events;
      }

      if (parsed.type === 'result') {
        // The turn is over, so nothing more will be asked and stdin can close.
        // Left open it would hold a process that has already answered.
        channel?.end();

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

          const id =
            typeof block.id === 'string' && block.id !== ''
              ? block.id
              : `call_${Math.random().toString(36).substring(2, 8)}`;
          // Remembered so a refusal arriving later can name the tool it refused.
          toolNames.set(id, block.name);

          const target = readActivityTarget(block.input);

          activities.push({
            type: 'activity',
            id,
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

      // Thinking streams through the same event as an answer, on a block of its
      // own. Reported as reasoning so the two never run together in the
      // transcript. See ADR-037.
      if (delta?.type === 'thinking_delta') {
        return typeof delta.thinking === 'string' && delta.thinking !== ''
          ? { type: 'reasoning', text: delta.thinking }
          : undefined;
      }

      if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '') {
        return undefined;
      }

      return { type: 'delta', text: delta.text };
    };

    // With asks on, the prompt travels as a streaming JSON message so stdin can
    // stay open for the control protocol. Plain text is kept for the case where
    // nobody can answer, because then there is nothing to keep stdin open for.
    const input = interactive
      ? `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
        })}\n`
      : text;

    return streamProcess(
      {
        command: COMMAND,
        args: [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          ...(interactive
            ? ['--input-format', 'stream-json', '--permission-prompt-tool', PERMISSION_PROMPT_TOOL]
            : []),
          ...(options.model !== undefined ? ['--model', options.model] : []),
          ...(resume !== undefined ? ['--resume', resume] : []),
        ],
        cwd: options.cwd,
        input,
        ...(interactive
          ? {
              onReady: (ready: ProcessChannel) => {
                channel = ready;
              },
            }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
      mapLine,
    );
  }
}
