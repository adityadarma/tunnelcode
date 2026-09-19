import { readActivityTarget } from '../activity.js';
import { captureOutput, isOnPath, MODEL_LIST_TIMEOUT_MS } from '../which.js';
import { RpcFailure, startJsonRpc } from './json-rpc.js';
import type { RpcConnection, RpcRequest } from './json-rpc.js';
import type {
  EngineModel,
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'agent';

/**
 * The subcommand that starts Cursor's ACP server.
 *
 * Undocumented and hidden: it is registered with a hidden flag, so it appears in
 * neither `agent --help` nor the online reference, and only `agent acp --help`
 * admits to it. Load-bearing all the same, and pinned by a test for the same
 * reason Claude Code's `--permission-prompt-tool` is pinned. Every visible surface
 * decides tool calls from Cursor's own allowlist, so a call that needs approval is
 * either run unasked under `--force` or left waiting on a terminal nobody is
 * watching. Over ACP the agent asks and the ask reaches the browser. See ADR-050.
 */
const ACP_ARGUMENT = 'acp';

/**
 * ACP revision this adapter speaks. Bumped only for breaking changes, so a
 * mismatch is worth reporting rather than working around.
 */
const PROTOCOL_VERSION = 1;

/**
 * The mode a conversation is answered in.
 *
 * `plan` and `ask` are read-only: an agent in either studies the workspace and
 * proposes, so a conversation left in one would answer every prompt with a plan
 * and never do the work. Set here rather than read from Cursor's own settings,
 * because what decides whether the engine can act at all, and therefore whether
 * an ask is ever raised, is a limit this project states rather than inherits.
 * See ADR-048.
 */
const AGENT_MODE = 'agent';

/** JSON-RPC code for a request whose parameters the peer would not accept. */
const INVALID_PARAMS = -32602;

/**
 * How Cursor words a session it no longer holds.
 *
 * Matched against the wording rather than trusted from the code alone, because
 * `-32602` is what it answers for any parameter it dislikes. The text arrives in
 * the error's `data.message` as `Session "<id>" not found`, and the code without
 * the wording would make every mistyped parameter look like a pruned conversation.
 */
const SESSION_MISSING = /session\b.*\bnot found/i;

/**
 * How a refusal for want of a login reads.
 *
 * Matched against the agent's own wording so a quota, a rate limit or an internal
 * error is reported as itself. Read as a login problem, every one of them would
 * send the user to `agent login` to fix something a login cannot fix.
 */
const AUTH_MESSAGE = /not logged in|log ?in|unauthenticated|authenticat|credential|expired token/i;

/**
 * How Cursor words a missing login on stderr.
 *
 * Read as well as any error code because the refusal can arrive before a request
 * is answered, in which case the process exits and no code ever comes back.
 */
const NOT_LOGGED_IN = /not logged in|run ['"]?agent login/i;

/** Explains a missing login in terms of the command that fixes it. */
const LOGIN_MESSAGE = 'Cursor is not logged in. Run agent login on this machine, then try again.';

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

interface ToolCallContent {
  type?: unknown;
  content?: ContentBlock;
}

interface ToolCallLocation {
  path?: unknown;
}

/**
 * One `session/update` payload.
 *
 * Every field is optional and typed as unknown, because an update carries only
 * what changed: a call announced with a kind and arguments is updated with a
 * status and nothing else. A narrower type would make an absent field look
 * present.
 */
interface SessionUpdate {
  sessionUpdate?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown;
}

interface PermissionOption {
  optionId?: unknown;
  name?: unknown;
  kind?: unknown;
}

/**
 * What is known about one tool call so far.
 *
 * Accumulated across updates for the reason above: read one update at a time, a
 * call would be reported as an unnamed tool acting on nothing.
 */
export interface ToolMemo {
  tool: string;
  target?: string;
  reported: boolean;
  /**
   * Whether this call was refused here.
   *
   * Remembered because Cursor then fails the call with a notice of its own,
   * worded as the user having denied it. The refusal is reported a level up, where
   * the real reason is known: a person may have said no, or a limit on this
   * machine may have, in which case nobody was asked at all.
   */
  refused?: boolean;
}

/**
 * Whether `session/load` failed because Cursor no longer holds the id.
 *
 * Stated by the code that made the request rather than guessed from the order
 * events arrived in. Its siblings infer staleness from "an error came before
 * anything else", which cannot tell a pruned conversation from a parameter this
 * adapter got wrong, and the two want opposite handling: one is retried in
 * silence, the other has to be reported.
 */
interface StaleSession {
  stale: boolean;
}

/**
 * Reads the text of a content block. Only text is read: an image or an audio clip
 * has no place in a transcript relayed as text.
 */
export function readText(content: unknown): string {
  if (typeof content !== 'object' || content === null) {
    return '';
  }

  const block = content as ContentBlock;
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/**
 * Names the tool a call is for.
 *
 * Cursor reports no name of its own beyond the ACP kind, so the kind is what a
 * permission rule on this machine is written against for this engine. The title is
 * the fallback and reads as a sentence, which is why it is second. No list of tool
 * names is kept here: a table of them would go stale the moment Cursor added one,
 * and silently mislabel it.
 */
export function readToolName(update: SessionUpdate | undefined): string | undefined {
  const kind = update?.kind;

  if (typeof kind === 'string' && kind !== '') {
    return kind;
  }

  const title = update?.title;
  return typeof title === 'string' && title !== '' ? title : undefined;
}

/**
 * Picks what a tool call acted on.
 *
 * The arguments are preferred over the reported locations, because they are what a
 * permission rule is judged against. Recorded whole: a target is read as the thing
 * that happened, and cutting it would change what a rule granted for it means.
 */
export function readTarget(update: SessionUpdate): string | undefined {
  const fromInput = readActivityTarget(update.rawInput);

  if (fromInput !== undefined) {
    return fromInput;
  }

  const locations = Array.isArray(update.locations)
    ? (update.locations as ToolCallLocation[])
    : undefined;
  const path = locations?.find((entry) => typeof entry.path === 'string' && entry.path !== '');

  return typeof path?.path === 'string' ? path.path : undefined;
}

/** Every text entry of a content array, in order. */
function readContentText(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];

  for (const entry of content as ToolCallContent[]) {
    if (entry.type !== 'content') {
      continue;
    }

    const text = readText(entry.content);

    if (text !== '') {
      parts.push(text);
    }
  }

  return parts;
}

/**
 * Reads what a tool call reported.
 *
 * Content first, because that is what the agent chose to show. `rawOutput` is the
 * fallback for a shell call, which reports itself only there: Cursor sends
 * `{exitCode, stdout, stderr}` and nothing else, so without this a command that
 * ran would appear to have produced nothing.
 */
export function readToolOutput(update: SessionUpdate): string {
  const parts = readContentText(update.content);

  if (parts.length > 0) {
    return parts.join('\n');
  }

  const raw = update.rawOutput;

  if (typeof raw !== 'object' || raw === null) {
    return '';
  }

  const record = raw as { stdout?: unknown; stderr?: unknown; exitCode?: unknown };
  const streams: string[] = [];

  if (typeof record.stdout === 'string' && record.stdout.trim() !== '') {
    streams.push(record.stdout.trimEnd());
  }

  if (typeof record.stderr === 'string' && record.stderr.trim() !== '') {
    streams.push(record.stderr.trimEnd());
  }

  if (streams.length > 0) {
    return streams.join('\n');
  }

  // A command that printed nothing still says how it went, since an answer that
  // works around a failed command otherwise has no visible cause.
  return typeof record.exitCode === 'number' && record.exitCode !== 0
    ? `Exited with code ${String(record.exitCode)}.`
    : '';
}

/**
 * Why Cursor is asking, in its own words.
 *
 * The ask carries a short explanation as content, such as `Not in allowlist: echo`,
 * which is the difference between a card that names a rule and one that only names
 * a command. Collapsed to a line because it is shown as one.
 */
export function readAskReason(call: SessionUpdate | undefined): string | undefined {
  const parts = readContentText(call?.content);

  if (parts.length === 0) {
    return undefined;
  }

  const reason = parts.join(' ').replace(/\s+/g, ' ').trim();
  return reason === '' ? undefined : reason;
}

/**
 * Puts a tool call id on one line.
 *
 * Cursor's ids contain a literal newline — a recorded one reads
 * `call-0f46d617-…-0\nfc_87d7cc5d-…_0` — so an id named inside a message a person
 * reads would otherwise break the message in half. Only the line breaks go:
 * everything else is kept, because a shortened id names nothing.
 */
export function oneLine(id: string): string {
  return id.replace(/[\r\n]+/g, ' ');
}

/** Whether a failure says Cursor no longer holds the session that was asked for. */
export function isSessionMissing(error: unknown): boolean {
  if (!(error instanceof RpcFailure) || error.code !== INVALID_PARAMS) {
    return false;
  }

  if (SESSION_MISSING.test(error.message)) {
    return true;
  }

  // Where Cursor actually puts it. The message itself only says "Invalid params".
  const data = error.data;
  const nested =
    typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined;

  return typeof nested === 'string' && SESSION_MISSING.test(nested);
}

/** The tool call an ask is about, which is how it is matched to what was announced. */
function readAskedCallId(params: unknown): string {
  const call =
    typeof params === 'object' && params !== null
      ? (params as { toolCall?: { toolCallId?: unknown } }).toolCall
      : undefined;

  return typeof call?.toolCallId === 'string' ? call.toolCallId : '';
}

/**
 * Turns an ACP permission request into the shape the caller answers.
 *
 * What the call would do comes from what was already announced about it, keyed by
 * the tool call id: the ask repeats only some of it, so read alone it would reach
 * the phone as an unnamed tool acting on nothing and no rule on this machine could
 * match it.
 */
export function readPermissionRequest(
  id: string,
  params: unknown,
  tools: Map<string, ToolMemo>,
): EnginePermissionRequest | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }

  const record = params as { toolCall?: SessionUpdate; options?: unknown };
  const call = record.toolCall;

  if (call === undefined) {
    return undefined;
  }

  const announced = typeof call.toolCallId === 'string' ? tools.get(call.toolCallId) : undefined;

  const tool = announced?.tool ?? readToolName(call) ?? 'tool';
  const title = typeof call.title === 'string' && call.title !== '' ? call.title : tool;
  const target = announced?.target ?? readTarget(call);
  const reason = readAskReason(call);

  const options = Array.isArray(record.options) ? (record.options as PermissionOption[]) : [];

  return {
    id,
    tool,
    title,
    ...(target !== undefined ? { target } : {}),
    ...(reason !== undefined ? { reason } : {}),
    // One ask covers one tool call here, so the target is the whole of what is
    // being agreed to. The option labels are not listed as operations: they read as
    // Allow once, Allow always and Reject, and a grant judged against them would
    // never match the call it was made for.
    details: [],
    // Offered only when Cursor itself offers to remember the choice. Inventing one
    // would suggest a lasting grant nothing asked for.
    suggestions: options.some((option) => option.kind === 'allow_always')
      ? [target !== undefined ? `${tool}(${target})` : tool]
      : [],
  };
}

/**
 * Picks the option that carries out a decision, by the kinds Cursor offered.
 *
 * Chosen by kind and never by a remembered id, because the two do not agree:
 * Cursor spells its ids with hyphens where the kinds use underscores, so an id
 * guessed from a kind would name no option at all.
 */
export function chooseOption(
  options: PermissionOption[],
  decision: EnginePermissionDecision,
): string {
  const byKind = (kind: string): string | undefined => {
    const found = options.find(
      (option) => option.kind === kind && typeof option.optionId === 'string',
    );

    return typeof found?.optionId === 'string' ? found.optionId : undefined;
  };

  if (decision === 'reject') {
    // Rejecting once is preferred over rejecting for good: a refusal here answers
    // this call, and a lasting refusal is not what was decided.
    return byKind('reject_once') ?? byKind('reject_always') ?? '';
  }

  // 'always' allows on the wire exactly as 'once' does. Cursor's own allow_always
  // writes the grant into its allowlist, where Setup could neither list it nor
  // clear it, so the lasting half is recorded on this machine instead and this
  // option is never sent. See ADR-022.
  return byKind('allow_once') ?? '';
}

/**
 * Reads the models a session reported, which is the only list Cursor accepts.
 *
 * The id is kept exactly as reported, brackets and all: it is a parameterised string
 * such as `claude-opus-5[thinking=true,context=300k]`, and `session/set_model`
 * accepts only the whole of it — `claude-opus-5` on its own comes back as
 * `Invalid model value`. So nothing here parses or trims an id.
 *
 * The name is kept beside it as the label, which is the whole reason a model carries
 * two fields: `default[]` is what the engine takes back and `Auto` is what it means,
 * and neither can stand in for the other. See ADR-051.
 */
export function readModels(result: unknown): EngineModel[] {
  const models =
    typeof result === 'object' && result !== null
      ? (result as { models?: unknown }).models
      : undefined;
  const available =
    typeof models === 'object' && models !== null
      ? (models as { availableModels?: unknown }).availableModels
      : undefined;

  if (!Array.isArray(available)) {
    return [];
  }

  const found: EngineModel[] = [];

  for (const entry of available as { modelId?: unknown; name?: unknown }[]) {
    const id = entry.modelId;

    if (typeof id !== 'string' || id === '' || found.some((model) => model.id === id)) {
      continue;
    }

    const name = entry.name;
    found.push({ id, label: typeof name === 'string' && name.trim() !== '' ? name.trim() : id });
  }

  return found;
}

/** Maps one session/update notification onto engine events. */
export function mapUpdate(params: unknown, tools: Map<string, ToolMemo>): EngineEvent[] {
  if (typeof params !== 'object' || params === null) {
    return [];
  }

  const update = (params as { update?: SessionUpdate }).update;

  if (update === undefined) {
    return [];
  }

  const kind = update.sessionUpdate;

  if (kind === 'agent_message_chunk') {
    const text = readText(update.content);
    return text === '' ? [] : [{ type: 'delta', text }];
  }

  // Thinking, not the answer. Reported as its own event so it reads as the model
  // working itself out rather than as something said to the person. See ADR-037.
  if (kind === 'agent_thought_chunk') {
    const text = readText(update.content);
    return text === '' ? [] : [{ type: 'reasoning', text }];
  }

  // The prompt comes back as the user's own words, which are neither an answer nor
  // deliberation. Relaying it would replay the question as a reply to itself.
  //
  // A title Cursor picked for the conversation and the slash commands it offers are
  // not work either, so neither reaches the transcript.
  if (kind !== 'tool_call' && kind !== 'tool_call_update') {
    return [];
  }

  // Used exactly as it arrived, newline included: this is what correlates the ask,
  // the announcement and every later update, so normalising it here would split one
  // call into two.
  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';

  if (id === '') {
    return [];
  }

  const events: EngineEvent[] = [];
  const status = update.status;

  const memo = tools.get(id) ?? { tool: 'tool', reported: false };
  const named = readToolName(update);

  // Only fills a gap rather than overwriting: a later update repeats neither the
  // kind nor the title, and the first sighting is where both are said.
  if (named !== undefined && memo.tool === 'tool') {
    memo.tool = named;
  }

  const target = readTarget(update);

  if (target !== undefined) {
    memo.target = target;
  }

  tools.set(id, memo);

  // A call is announced pending, before its arguments are settled and before the
  // ask about it has been raised, so reporting it at that first sighting would show
  // a tool acting on nothing.
  if (!memo.reported && status !== 'pending') {
    memo.reported = true;

    events.push({
      type: 'activity',
      id,
      tool: memo.tool,
      ...(memo.target !== undefined ? { target: memo.target } : {}),
    });
  }

  // A call refused here fails with Cursor's own notice about it. Reporting that as
  // the call's output would state the refusal twice, and would credit it to the
  // user even when a limit on this machine was what refused.
  if (memo.refused === true) {
    return events;
  }

  const output = readToolOutput(update);

  if (output !== '') {
    events.push({ type: 'activity_output', id, output });
  }

  // A call that failed for its own reasons still says so, since an answer that
  // works around a failed tool otherwise has no visible cause.
  if (status === 'failed' && output === '') {
    events.push({ type: 'activity_output', id, output: 'The tool call failed.' });
  }

  return events;
}

/**
 * Cursor Agent CLI adapter.
 *
 * Driven through `agent acp`, which speaks the Agent Client Protocol over stdio:
 * JSON-RPC, one object per line. Chosen over the visible surfaces because they
 * cannot ask about a tool call in a way anything but a terminal can answer:
 * `agent -p` leaves the call waiting with no channel to carry the question out, and
 * `--force` runs everything without asking, which is what the limits set on this
 * machine exist to prevent. Over ACP the ask reaches the browser and the answer
 * returns to the turn that asked. See ADR-022 and ADR-050.
 *
 * Text arrives as `agent_message_chunk`. Thinking arrives as `agent_thought_chunk`
 * and is reported as reasoning rather than as answer text: it is the model working
 * itself out, so it belongs beside the answer rather than inside it. See ADR-037.
 *
 * Nothing on this surface reports token counts, so no usage event is ever emitted.
 * The rest of the system reads that as unknown rather than as zero, which is the
 * honest reading; reporting zeros would be inventing a number.
 */
export class CursorEngine implements Engine {
  readonly name = 'cursor';
  readonly label = 'Cursor';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Whether anyone is logged in.
   *
   * Read from the exit status of `agent status`, which answers the question rather
   * than trying to fix it: it reports that nobody is logged in and exits nonzero
   * without opening a browser. The status is the whole answer, and what it printed
   * is ignored: both outcomes are written in prose that can be reworded, and a
   * check against the wording would report every machine as logged out the day it
   * changed. Reading the status also covers `CURSOR_API_KEY` with no special case,
   * since the child inherits the environment.
   */
  private async isLoggedIn(timeoutMs?: number): Promise<boolean> {
    return (await captureOutput(COMMAND, ['status'], { timeoutMs })) !== undefined;
  }

  /**
   * Reads the model list from an ACP session.
   *
   * Deliberately not from `agent --list-models`. The two surfaces disagree: that
   * one prints a larger, human-formatted set, and `session/set_model` accepts none
   * of it, so offering that list would put choices in the browser that fail on the
   * machine.
   *
   * The login is checked first because a machine nobody has logged into has no list
   * to report, and starting an agent to be told so is work with no answer at the
   * end of it.
   *
   * An empty list is read as "use the engine default" rather than as a failure, so
   * the engine is still offered once someone logs in.
   */
  async listModels(): Promise<EngineModel[]> {
    if (!(await this.isLoggedIn(MODEL_LIST_TIMEOUT_MS))) {
      return [];
    }

    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(
        COMMAND,
        [ACP_ARGUMENT],
        process.cwd(),
        {
          onRequest: () => Promise.reject(new Error('Nothing is asked of a listing.')),
          onNotification: () => {
            // A listing has no turn, so the agent's updates are not its business.
          },
          onStderr: () => {
            // Diagnostics belong to a turn. Listing models has no transcript to put
            // them in, and a warning here is not a reason to offer no models.
          },
          onExit: () => {
            // The request below already fails when the process goes early, which is
            // what reports it.
          },
        },
        { timeoutMs: MODEL_LIST_TIMEOUT_MS },
      );

      await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      const created = await connection.request('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });

      return readModels(created);
    } catch {
      return [];
    } finally {
      connection?.close();
    }
  }

  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    return this.run(text, options);
  }

  /**
   * Runs the prompt, retrying once without the session id when Cursor no longer
   * holds it.
   *
   * A pruned id is expected rather than exceptional: conversations live in Cursor's
   * own store and can go at any time. Answering without the earlier context is
   * better than refusing to answer at all. Every other failure is passed through,
   * because retrying one as a fresh conversation would hide a bug behind lost
   * memory.
   */
  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    if (options.resume !== undefined) {
      const buffered: EngineEvent[] = [];
      const missing: StaleSession = { stale: false };
      let committed = false;

      for await (const event of this.attempt(text, options, options.resume, missing)) {
        // Anything the engine produced means the session was found, so from here on
        // the run is passed straight through.
        if (event.type !== 'log' && event.type !== 'done' && event.type !== 'error') {
          committed = true;
        }

        // A failure caused by the missing session is not worth reporting when the
        // retry is about to answer properly.
        if (missing.stale && (event.type === 'error' || event.type === 'done')) {
          continue;
        }

        if (committed) {
          yield* buffered.splice(0, buffered.length);
          yield event;
          continue;
        }

        buffered.push(event);
      }

      if (!missing.stale) {
        yield* buffered;
        return;
      }
    }

    yield* this.attempt(text, options, undefined, { stale: false });
  }

  /** One engine run, with or without a session to continue. */
  private async *attempt(
    text: string,
    options: PromptOptions,
    resume: string | undefined,
    missing: StaleSession,
  ): AsyncGenerator<EngineEvent> {
    const queue: (EngineEvent | null)[] = [];
    let notify: (() => void) | undefined;
    let ended = false;
    let finished = false;

    const push = (event: EngineEvent | null): void => {
      if (ended) {
        return;
      }

      if (event === null) {
        ended = true;
      }

      queue.push(event);
      const wake = notify;
      notify = undefined;
      wake?.();
    };

    /**
     * Whether the agent refused for want of a login.
     *
     * Remembered because the refusal can arrive on stderr and the process then
     * exits, so the JSON-RPC error that would carry a code never comes back.
     */
    let needsLogin = false;

    /**
     * Whether `session/load` is still replaying the conversation it was given.
     *
     * Cursor answers a load by resending every earlier turn as `session/update`
     * notifications — the thinking, the tool calls and the answers — and only then
     * returns. Read as this turn's own output, a resumed conversation would repeat
     * the last answer before producing a new one, and would re-announce tool calls
     * under ids Cursor mints per load: `replay-0-1` is the first call of the first
     * turn every time, so the second resume of a conversation reports an id the
     * first already stored.
     *
     * Discarded rather than reconciled. This project keeps its own transcript, so
     * a replay carries nothing it does not already have, and nothing here has to
     * decide which half of a duplicate is the real one.
     */
    let replaying = false;

    const tools = new Map<string, ToolMemo>();

    /** Answers one ask, once the caller has decided. */
    const decide = async (request: RpcRequest): Promise<unknown> => {
      const params = request.params;
      const offered_ =
        typeof params === 'object' && params !== null
          ? ((params as { options?: unknown }).options ?? [])
          : [];
      const offered = Array.isArray(offered_) ? (offered_ as PermissionOption[]) : [];
      const ask = readPermissionRequest(String(request.id), params, tools);
      const requestPermission = options.requestPermission;

      // Refusal is the fallback whenever nobody can answer, because the alternative
      // is running a tool call nobody agreed to.
      let decision: EnginePermissionDecision = 'reject';

      if (ask !== undefined && requestPermission !== undefined) {
        try {
          decision = await requestPermission(ask);
        } catch {
          decision = 'reject';
        }
      }

      if (decision === 'reject') {
        const memo = tools.get(readAskedCallId(params));

        if (memo !== undefined) {
          memo.refused = true;
        }
      }

      const optionId = chooseOption(offered, decision);

      // An agent that offered nothing this decision can be carried out with is told
      // the turn was cancelled, which is the only other outcome ACP defines and
      // better than inventing an option id.
      if (optionId === '') {
        return { outcome: { outcome: 'cancelled' } };
      }

      return { outcome: { outcome: 'selected', optionId } };
    };

    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(COMMAND, [ACP_ARGUMENT], options.cwd, {
        onRequest: async (request) => {
          if (request.method === 'session/request_permission') {
            return decide(request);
          }

          // The file system and terminal capabilities are declined below, so the
          // agent should never ask for them. Anything else is a question this
          // adapter cannot answer honestly, and one answered by guessing would grant
          // something nobody agreed to. Refusing by name leaves the agent to carry
          // on without it. See ADR-048.
          throw new Error(`Unsupported request: ${request.method}`);
        },
        onNotification: (method, params) => {
          if (method !== 'session/update') {
            return;
          }

          // The conversation being read back to us, not the turn happening now.
          if (replaying) {
            return;
          }

          for (const event of mapUpdate(params, tools)) {
            push(event);
          }
        },
        onStderr: (line) => {
          if (NOT_LOGGED_IN.test(line)) {
            needsLogin = true;
            return;
          }

          push({ type: 'log', text: line });
        },
        onExit: () => {
          // Reached when the agent ends on its own, which is a turn that will never
          // be answered. Ending it here rather than waiting is what stops the turn
          // hanging on a process that has already gone.
          //
          // A turn that reported its own outcome is left alone: it is about to end,
          // and the exit is a consequence of that rather than news.
          if (finished) {
            return;
          }

          finished = true;
          push({
            type: 'error',
            message: needsLogin ? LOGIN_MESSAGE : 'Cursor ended before finishing the turn.',
          });
          push({ type: 'done', exitCode: 1 });
          push(null);
        },
      });
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot start Cursor.',
      };
      yield { type: 'done', exitCode: 127 };
      return;
    }

    const live = connection;

    /** Drives the turn, pushing what it learns onto the same queue as the updates. */
    const turn = async (): Promise<void> => {
      try {
        await live.request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          // Declined deliberately. The agent runs on this machine and reaches the
          // workspace through its own tools, which is what an ask is raised about.
          // Granting these would let it read, write and run around that, unasked.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });

        // Only a load replays, and only until it answers. Cleared in a finally
        // because a load that fails has replayed just as much as one that worked,
        // and the fresh conversation that follows reports work of its own.
        replaying = resume !== undefined;

        let opened: OpenedSession;

        try {
          opened = await openSession(live, options, resume, missing);
        } finally {
          replaying = false;
        }

        // Reported before any answer, so a run cut short still leaves an id to
        // continue from.
        push({ type: 'session', id: opened.sessionId });

        const wrongMode = ensureAgentMode(opened.modes);

        if (wrongMode) {
          const refused = await setMode(live, opened.sessionId);

          if (refused !== undefined) {
            push({ type: 'log', text: refused });
          }
        }

        if (options.model !== undefined && options.model !== '') {
          const refused = await chooseModel(live, opened.sessionId, options.model);

          if (refused !== undefined) {
            push({ type: 'log', text: refused });
          }
        }

        const cancel = (): void => {
          live.notify('session/cancel', { sessionId: opened.sessionId });
        };

        options.signal?.addEventListener('abort', cancel, { once: true });

        try {
          const result = await live.request('session/prompt', {
            sessionId: opened.sessionId,
            // The prompt travels as one text block, carrying the text exactly as it
            // was given: nothing is quoted, escaped or reflowed on the way.
            prompt: [{ type: 'text', text }],
          });

          const stopReason =
            typeof result === 'object' && result !== null
              ? (result as { stopReason?: unknown }).stopReason
              : undefined;

          // Claimed before anything is reported, so the exit that follows a turn
          // ending normally is not announced as a turn that never finished.
          finished = true;

          // refusal is the agent declining to continue, which is a turn that
          // produced no answer rather than a crash. Every other stop reason,
          // including a cancellation the caller asked for, ends the turn without an
          // error: describing a stop the user asked for as a failure is a lie the
          // transcript would keep repeating. See ADR-042.
          if (stopReason === 'refusal') {
            push({ type: 'error', message: 'Cursor refused to continue this turn.' });
            push({ type: 'done', exitCode: 1 });
            return;
          }

          push({ type: 'done', exitCode: 0 });
        } finally {
          options.signal?.removeEventListener('abort', cancel);
        }
      } catch (error) {
        // The exit handler may have reported this already: an agent that dies
        // mid-request fails the request too, and both would describe it.
        if (finished) {
          return;
        }

        finished = true;
        const authFailed =
          needsLogin ||
          (error instanceof RpcFailure && AUTH_MESSAGE.test(error.message)) ||
          (error instanceof Error && AUTH_MESSAGE.test(error.message));

        push({
          type: 'error',
          message: authFailed
            ? LOGIN_MESSAGE
            : error instanceof Error
              ? error.message
              : 'Cursor reported an error.',
        });
        push({ type: 'done', exitCode: 1 });
      } finally {
        push(null);
      }
    };

    void turn();

    const next = async (): Promise<EngineEvent | null> => {
      for (;;) {
        const event = queue.shift();

        if (event !== undefined) {
          return event;
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    };

    try {
      for (let event = await next(); event !== null; event = await next()) {
        yield event;
      }
    } finally {
      // Cursor holds a conversation open per connection, so leaving it running would
      // keep an agent with access to the workspace alive after the turn ended. The
      // finally is what covers a consumer that stopped reading early. See ADR-044.
      connection.close();
    }
  }
}

/** What opening a session reported about it. */
interface OpenedSession {
  sessionId: string;
  /** The modes it reported, so a read-only one can be corrected before prompting. */
  modes: unknown;
}

/**
 * Opens the session to prompt into.
 *
 * A pruned id is recorded on the flag the caller passes in rather than inferred
 * from it being the first failure, because only this function knows the difference
 * between a conversation Cursor has forgotten and a parameter that was wrong.
 */
async function openSession(
  connection: RpcConnection,
  options: PromptOptions,
  resume: string | undefined,
  missing: StaleSession,
): Promise<OpenedSession> {
  if (resume !== undefined) {
    try {
      const loaded = await connection.request('session/load', {
        sessionId: resume,
        cwd: options.cwd,
        mcpServers: [],
      });

      // The id is the one that was asked for: a load that reported a different one
      // would be a different conversation, so the response is only read for the
      // modes it carries.
      return { sessionId: resume, modes: readModes(loaded) };
    } catch (error) {
      if (isSessionMissing(error)) {
        missing.stale = true;
      }

      throw error;
    }
  }

  const created = await connection.request('session/new', {
    cwd: options.cwd,
    mcpServers: [],
  });

  const id =
    typeof created === 'object' && created !== null
      ? (created as { sessionId?: unknown }).sessionId
      : undefined;

  if (typeof id !== 'string' || id === '') {
    throw new Error('Cursor started a session with no id.');
  }

  return { sessionId: id, modes: readModes(created) };
}

function readModes(result: unknown): unknown {
  return typeof result === 'object' && result !== null
    ? (result as { modes?: unknown }).modes
    : undefined;
}

/**
 * Whether the session needs telling to work rather than plan.
 *
 * Nothing is sent when it is already in `agent`, which is what a new session
 * reports, so the common case costs no request. Nothing is sent either when the
 * agent mode is not on offer: naming a mode the session does not have would be
 * refused, and a refusal here is noise rather than news.
 */
export function ensureAgentMode(modes: unknown): boolean {
  if (typeof modes !== 'object' || modes === null) {
    return false;
  }

  const record = modes as { currentModeId?: unknown; availableModes?: unknown };

  if (record.currentModeId === AGENT_MODE) {
    return false;
  }

  const available = Array.isArray(record.availableModes)
    ? (record.availableModes as { id?: unknown }[])
    : [];

  return available.some((mode) => mode.id === AGENT_MODE);
}

/**
 * Puts the session into the mode that can do the work.
 *
 * Returns what went wrong instead of throwing. A mode Cursor would not change is a
 * preference, and losing an otherwise working answer over it would be worse than
 * answering in the mode it kept.
 */
async function setMode(connection: RpcConnection, sessionId: string): Promise<string | undefined> {
  try {
    await connection.request('session/set_mode', { sessionId, modeId: AGENT_MODE });
    return undefined;
  } catch (error) {
    return `Cursor would not switch to its ${AGENT_MODE} mode: ${
      error instanceof Error ? error.message : 'the mode was refused'
    }. Answering in the mode it is in instead.`;
  }
}

/**
 * Asks the session to answer with a chosen model.
 *
 * Told to the open session rather than passed at spawn time, so a model changed in
 * the browser takes effect on a conversation that already exists.
 *
 * Returns what went wrong instead of throwing, for the same reason the mode does.
 */
async function chooseModel(
  connection: RpcConnection,
  sessionId: string,
  model: string,
): Promise<string | undefined> {
  try {
    await connection.request('session/set_model', { sessionId, modelId: model });
    return undefined;
  } catch (error) {
    return `Cursor would not answer with ${model}: ${
      error instanceof Error ? error.message : 'the model was refused'
    }. Answering with its default instead.`;
  }
}
