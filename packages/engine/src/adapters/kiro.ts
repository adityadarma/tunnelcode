import { readActivityTarget } from '../activity.js';
import { captureOutput, isOnPath } from '../which.js';
import { AcpError, startAcp } from './kiro-acp.js';
import type { AcpConnection, RpcRequest } from './kiro-acp.js';
import type {
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'kiro-cli';

/**
 * ACP revision this adapter speaks. Bumped only for breaking changes, so a
 * mismatch is worth reporting rather than working around.
 */
const PROTOCOL_VERSION = 1;

/**
 * The code the agent reports a missing login under.
 *
 * Not enough on its own to mean that. JSON-RPC leaves -32000 and the codes below
 * it to the implementation, so it is what an agent reaches for whenever something
 * went wrong on its side, and the transport here uses it for a connection that
 * ended too. The message has to agree before a failure is called a login problem.
 */
const AUTH_REQUIRED = -32000;

/**
 * How a refusal for want of a login reads.
 *
 * Matched against the agent's own wording, so a quota, a rate limit or an
 * internal error is reported as itself. Read as a login problem, every one of
 * them would send the user back to kiro-cli login to fix something a login
 * cannot fix.
 */
const AUTH_MESSAGE = /not logged in|log ?in|unauthenticated|authenticat|credential|expired token/i;

/**
 * How kiro-cli words a missing login on stderr.
 *
 * Read as well as the error code because the refusal arrives on stderr before
 * any request is answered: the process exits, so the code never comes back.
 */
const NOT_LOGGED_IN = /not logged in/i;

/** Explains a missing login in terms of the command that fixes it. */
const LOGIN_MESSAGE = 'Kiro is not logged in. Run kiro-cli login on this machine, then try again.';

/**
 * A model line in the plain listing, which is what `--format plain` prints.
 *
 * Pinned to the credit column rather than to the shape of an id, because the
 * listing's heading is a word like any other and the default model is named
 * `auto`, which no id pattern would let through.
 */
const MODEL_LINE = /^\*?\s*(\S+)\s+\d+(?:\.\d+)?x\s+credits\b/i;

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

interface ToolCallContent {
  type?: unknown;
  content?: ContentBlock;
  path?: unknown;
  newText?: unknown;
}

interface ToolCallLocation {
  path?: unknown;
}

/** One entry of the tool's own result, as kiro reports it beside the content. */
interface RawOutputItem {
  Text?: unknown;
}

interface SessionUpdate {
  sessionUpdate?: unknown;
  content?: ContentBlock;
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown;
  _meta?: unknown;
}

interface PermissionOption {
  optionId?: unknown;
  name?: unknown;
  kind?: unknown;
}

/**
 * Reads the text of a content block. Only text is read: an image or an audio
 * clip has no place in a transcript that is relayed as text.
 */
function readText(content: ContentBlock | undefined): string {
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

/**
 * Picks what a tool call acted on.
 *
 * The arguments are preferred over the reported locations, because they are what
 * a permission rule is judged against. A location is the fallback for an agent
 * that reports where it worked without saying how it was asked to.
 */
function readTarget(update: SessionUpdate): string | undefined {
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

/**
 * Reads what a tool call reported.
 *
 * A diff is deliberately not read. It carries the whole new contents of a file,
 * and its path is absolute where the activity already names the file as the
 * workspace sees it, so reading it would put a file body and a second path into
 * the transcript.
 */
function readToolOutput(update: SessionUpdate): string {
  const parts: string[] = [];

  if (Array.isArray(update.content)) {
    for (const entry of update.content as ToolCallContent[]) {
      if (entry.type !== 'content') {
        continue;
      }

      const text = readText(entry.content);

      if (text !== '') {
        parts.push(text);
      }
    }
  }

  if (parts.length > 0) {
    return parts.join('\n');
  }

  // Some tools report nothing as content and only summarise themselves in their
  // own result, which is the only thing left to show the call did anything. The
  // structured half of that result is skipped: a tool that fills it has already
  // streamed the same text as content.
  const raw = update.rawOutput;
  const items =
    typeof raw === 'object' && raw !== null ? (raw as { items?: unknown }).items : undefined;

  if (!Array.isArray(items)) {
    return '';
  }

  return (items as RawOutputItem[])
    .map((item) => (typeof item.Text === 'string' ? item.Text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Reads the name kiro gives the tool itself.
 *
 * Preferred over the ACP kind, which sorts tools into a handful of categories:
 * `shell` and `write` are what the engine calls them and what a permission rule
 * on this machine is therefore written against, where `execute` and `edit` would
 * cover several tools at once.
 */
function readToolName(update: SessionUpdate | undefined): string | undefined {
  const meta = update?._meta;
  const kiro =
    typeof meta === 'object' && meta !== null ? (meta as { kiro?: unknown }).kiro : undefined;
  const name =
    typeof kiro === 'object' && kiro !== null
      ? (kiro as { toolName?: unknown }).toolName
      : undefined;

  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * Turns an ACP permission request into the shape the caller answers.
 *
 * What the call would do is taken from what was already announced about it, keyed
 * by the tool call id: the ask itself carries only that id and a title, so read
 * alone it would reach the phone as an unnamed tool acting on nothing, and a rule
 * on this machine would have nothing to match.
 *
 * The options the agent offers are read rather than assumed: which of them exist
 * decides what an answer can be, and an agent that offers no lasting grant cannot
 * be told to remember one.
 */
function readPermissionRequest(
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

  const tool =
    announced?.tool ??
    readToolName(call) ??
    (typeof call.kind === 'string' && call.kind !== '' ? call.kind : 'tool');
  const title = typeof call.title === 'string' && call.title !== '' ? call.title : tool;
  const target = announced?.target ?? readTarget(call);

  const options = Array.isArray(record.options) ? (record.options as PermissionOption[]) : [];

  return {
    id,
    tool,
    title,
    ...(target !== undefined ? { target } : {}),
    // One ask covers one tool call here, so the target is the whole of what is
    // being agreed to. The option labels are not listed as operations: they read
    // as Yes, Always and No, and a grant judged against them would never match
    // the call it was made for.
    details: [],
    // Reported only when the agent itself offers to remember the choice. Inventing
    // a rule here would offer a lasting grant the agent has no way to apply.
    suggestions: options.some((option) => option.kind === 'allow_always')
      ? [target !== undefined ? `${tool}(${target})` : tool]
      : [],
  };
}

/** The tool call an ask is about, which is all the ask says about it. */
function readAskedCallId(params: unknown): string {
  const call =
    typeof params === 'object' && params !== null
      ? (params as { toolCall?: { toolCallId?: unknown } }).toolCall
      : undefined;

  return typeof call?.toolCallId === 'string' ? call.toolCallId : '';
}

/** Picks the option that carries out a decision, by the kinds the agent offered. */
function chooseOption(options: PermissionOption[], decision: EnginePermissionDecision): string {
  const byKind = (kind: string): string | undefined => {
    const found = options.find(
      (option) => option.kind === kind && typeof option.optionId === 'string',
    );

    return typeof found?.optionId === 'string' ? found.optionId : undefined;
  };

  if (decision === 'reject') {
    // Rejecting once is preferred over rejecting for good: a refusal here is this
    // call's answer, and a lasting refusal is not what was decided.
    return byKind('reject_once') ?? byKind('reject_always') ?? '';
  }

  // 'always' is recorded on this machine rather than in the agent, so it allows on
  // the wire exactly as 'once' does. See ADR-022.
  return byKind('allow_once') ?? byKind('allow_always') ?? '';
}

/**
 * Kiro CLI adapter.
 *
 * Driven through `kiro-cli acp`, which speaks the Agent Client Protocol over
 * stdio: JSON-RPC, one object per line. Chosen over `kiro-cli chat
 * --no-interactive` because that surface cannot ask about a tool call at all. Its
 * only permission controls are `--trust-all-tools` and `--trust-tools`, and the
 * first approves every call on the agent's behalf, which is what the limits set on
 * this machine exist to prevent.
 *
 * ACP asks over `session/request_permission`, so a call the agent will not make
 * alone reaches the browser and the answer returns to the turn that asked. See
 * ADR-022.
 *
 * Text arrives as `agent_message_chunk`. Thinking arrives as
 * `agent_thought_chunk` and is reported as reasoning rather than as answer text:
 * it is the model working itself out, so it belongs beside the answer rather than
 * inside it. See ADR-037.
 */
export class KiroEngine implements Engine {
  readonly name = 'kiro';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Whether anyone is logged in.
   *
   * Asked with `user whoami`, which answers the question instead of trying to fix
   * it: it prints that nobody is logged in and exits. Every other command starts a
   * device login flow, opens a browser and waits for it to be completed.
   */
  private async isLoggedIn(): Promise<boolean> {
    return (await captureOutput(COMMAND, ['user', 'whoami'])) !== undefined;
  }

  /**
   * Reads the model list from `kiro-cli chat --list-models`.
   *
   * The login is checked first because listing models on a machine with no login
   * does not fail: kiro-cli opens a browser and waits for someone to log in. That
   * runs during discovery, so a person who only opened the menu would be handed a
   * login page they never asked for, and startup would sit there until they
   * finished it or the probe timed out.
   *
   * An empty list is read as "use the engine default" rather than as a failure, so
   * the engine is still offered once someone logs in.
   */
  async listModels(): Promise<string[]> {
    if (!(await this.isLoggedIn())) {
      return [];
    }

    const output = await captureOutput(COMMAND, ['chat', '--list-models', '--format', 'json']);

    if (output === undefined) {
      return [];
    }

    const parsed = readModelJson(output);

    if (parsed.length > 0) {
      return parsed;
    }

    // The plain format is the fallback, for a version whose --format is missing or
    // spelled differently.
    const ids: string[] = [];

    for (const line of output.split('\n')) {
      const id = MODEL_LINE.exec(line)?.[1] ?? '';

      if (id !== '' && !ids.includes(id)) {
        ids.push(id);
      }
    }

    return ids;
  }

  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    return this.run(text, options);
  }

  /**
   * Runs the prompt, retrying once without the session id when resuming was
   * refused.
   *
   * A stale id is expected rather than exceptional: sessions live in Kiro's own
   * store and can be pruned at any time. Answering without the earlier context is
   * better than refusing to answer at all.
   */
  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    if (options.resume !== undefined) {
      const buffered: EngineEvent[] = [];
      let committed = false;
      let stale = false;

      for await (const event of this.attempt(text, options, options.resume)) {
        // Anything the engine produced means the session was found, so from here on
        // the run is passed straight through.
        if (event.type !== 'log' && event.type !== 'done' && event.type !== 'error') {
          committed = true;
        }

        if (!committed && event.type === 'error') {
          stale = true;
          continue;
        }

        // A failure caused by the missing session is not worth reporting when the
        // retry is about to answer properly.
        if (stale && event.type === 'done') {
          continue;
        }

        if (committed) {
          yield* buffered.splice(0, buffered.length);
          yield event;
          continue;
        }

        buffered.push(event);
      }

      if (!stale) {
        yield* buffered;
        return;
      }
    }

    yield* this.attempt(text, options, undefined);
  }

  /** One engine run, with or without a session to continue. */
  private async *attempt(
    text: string,
    options: PromptOptions,
    resume: string | undefined,
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
      const resume = notify;
      notify = undefined;
      resume?.();
    };

    /**
     * Whether the agent refused for want of a login.
     *
     * Remembered because the refusal arrives on stderr and the process then exits,
     * so the JSON-RPC error that would carry the code never comes back.
     */
    let needsLogin = false;

    /**
     * Whether the agent is replaying history rather than producing it.
     *
     * Continuing a conversation replays every earlier message and tool call as
     * ordinary updates, so nothing is relayed while that is happening: the
     * transcript is already stored here, and relaying it would repeat the whole
     * conversation inside this one answer.
     */
    let replaying = false;
    const tools = new Map<string, ToolMemo>();

    /** Answers one ask, once the caller has decided. */
    const decide = async (request: RpcRequest): Promise<unknown> => {
      const params = request.params;
      const options_ =
        typeof params === 'object' && params !== null
          ? ((params as { options?: unknown }).options ?? [])
          : [];
      const offered = Array.isArray(options_) ? (options_ as PermissionOption[]) : [];
      const ask = readPermissionRequest(String(request.id), params, tools);
      const requestPermission = options.requestPermission;

      // Refusal is the fallback whenever nobody can answer, because the
      // alternative is running a tool call nobody agreed to.
      let decision: EnginePermissionDecision = 'reject';

      if (ask !== undefined && requestPermission !== undefined) {
        try {
          decision = await requestPermission(ask);
        } catch {
          decision = 'reject';
        }
      }

      if (decision === 'reject' && ask !== undefined) {
        const memo = tools.get(readAskedCallId(params));

        if (memo !== undefined) {
          memo.refused = true;
        }
      }

      const optionId = chooseOption(offered, decision);

      // An agent that offered nothing this decision can be carried out with is
      // told the turn was cancelled, which is the only other outcome ACP defines.
      if (optionId === '') {
        return { outcome: { outcome: 'cancelled' } };
      }

      return { outcome: { outcome: 'selected', optionId } };
    };

    let connection: AcpConnection | undefined;

    try {
      connection = await startAcp(COMMAND, ['acp'], options.cwd, {
        onRequest: async (request) => {
          if (request.method === 'session/request_permission') {
            return decide(request);
          }

          // The file system and terminal capabilities are declined below, so the
          // agent should never ask for them. Refusing loudly is better than
          // answering a call this adapter does not implement.
          throw new Error(`Unsupported request: ${request.method}`);
        },
        onNotification: (method, params) => {
          if (method !== 'session/update' || replaying) {
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
            message: needsLogin ? LOGIN_MESSAGE : 'Kiro ended before finishing the turn.',
          });
          push({ type: 'done', exitCode: 1 });
          push(null);
        },
      });
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot start Kiro.',
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
          // Granting these would let it read and write around that, unasked.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        });

        replaying = resume !== undefined;

        let sessionId: string;

        try {
          sessionId = await openSession(live, options, resume);
        } finally {
          replaying = false;
        }

        // Reported before any answer, so a run cut short still leaves an id to
        // continue from.
        push({ type: 'session', id: sessionId });

        if (options.model !== undefined && options.model !== '') {
          const refused = await chooseModel(live, sessionId, options.model);

          if (refused !== undefined) {
            push({ type: 'log', text: refused });
          }
        }

        const cancel = (): void => {
          live.notify('session/cancel', { sessionId });
        };

        options.signal?.addEventListener('abort', cancel, { once: true });

        try {
          const result = await live.request('session/prompt', {
            sessionId,
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
          // produced no answer rather than a crash.
          if (stopReason === 'refusal') {
            push({ type: 'error', message: 'Kiro refused to continue this turn.' });
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
          (error instanceof AcpError &&
            error.code === AUTH_REQUIRED &&
            AUTH_MESSAGE.test(error.message));

        push({
          type: 'error',
          message: authFailed
            ? LOGIN_MESSAGE
            : error instanceof Error
              ? error.message
              : 'Kiro reported an error.',
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
      // The agent holds a session open per connection, so leaving it running would
      // keep an agent with access to the workspace alive after the turn ended.
      connection.close();
    }
  }
}

/**
 * Opens the session to prompt into.
 *
 * A conversation is continued with `session/load`, which is the one ACP method
 * kiro-cli implements for it. Loading replays the whole transcript before it
 * answers, which is why the caller stops relaying updates until it returns.
 */
async function openSession(
  connection: AcpConnection,
  options: PromptOptions,
  resume: string | undefined,
): Promise<string> {
  if (resume !== undefined) {
    const loaded = await connection.request('session/load', {
      sessionId: resume,
      cwd: options.cwd,
      mcpServers: [],
    });

    // The response carries no id of its own: the session loaded is the one that
    // was asked for.
    void loaded;
    return resume;
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
    throw new Error('Kiro started a session with no id.');
  }

  return id;
}

/**
 * Asks the session to answer with a chosen model.
 *
 * Told to the session rather than passed on the command line, because the flag
 * only applies to a session being started: a continued conversation would keep
 * whatever model it was created with, and a model changed in the browser would
 * never take effect.
 *
 * Returns what went wrong instead of throwing. A model that cannot be set is a
 * preference the agent would not take, and losing an otherwise working turn over
 * it would be worse than answering on the default.
 */
async function chooseModel(
  connection: AcpConnection,
  sessionId: string,
  model: string,
): Promise<string | undefined> {
  try {
    await connection.request('session/set_model', { sessionId, modelId: model });
    return undefined;
  } catch (error) {
    return `Kiro would not answer with ${model}: ${
      error instanceof Error ? error.message : 'the model was refused'
    }. Answering with its default instead.`;
  }
}

/**
 * What is known about a tool call so far.
 *
 * Accumulated across updates because ACP sends a `tool_call_update` with only the
 * fields that changed: a call announced as `execute` is updated with a status and
 * no kind at all, and reading each update alone would report the call as an
 * unnamed tool acting on nothing.
 */
interface ToolMemo {
  tool: string;
  target?: string;
  reported: boolean;
  /**
   * Whether this call was refused here.
   *
   * Remembered because the agent then fails the call with a notice of its own,
   * worded as the user having denied it. The refusal is reported a level up, where
   * the actual reason is known: a person may have said no, or a limit on this
   * machine may have, in which case nobody was asked at all.
   */
  refused?: boolean;
}

/** Maps one session/update notification onto engine events. */
function mapUpdate(params: unknown, tools: Map<string, ToolMemo>): EngineEvent[] {
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

  // Thinking, not the answer. Reported as its own event, so it reads as the model
  // working itself out rather than as something said to the person. See ADR-037.
  if (kind === 'agent_thought_chunk') {
    const text = readText(update.content);
    return text === '' ? [] : [{ type: 'reasoning', text }];
  }

  // The prompt comes back as the user's own words, which are neither an answer nor
  // deliberation. Relaying it would replay the question as a reply to itself.
  if (kind === 'user_message_chunk') {
    return [];
  }

  if (kind !== 'tool_call' && kind !== 'tool_call_update') {
    return [];
  }

  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';

  if (id === '') {
    return [];
  }

  const events: EngineEvent[] = [];
  const status = update.status;

  // Everything learned about the call so far, because an update carries only what
  // changed. The kind is announced once, on the first sighting, and never repeated.
  const memo = tools.get(id) ?? { tool: 'tool', reported: false };
  const named = readToolName(update);

  if (named !== undefined) {
    memo.tool = named;
  } else if (memo.tool === 'tool') {
    // Nothing better has been learned yet. A kind is a category the engine sorts
    // tools into, and a title is a sentence written for a person, so both are
    // second choices to the name the engine gives the tool itself. A later update
    // repeats the kind without the name, which is why this only fills a gap
    // instead of overwriting.
    memo.tool =
      typeof update.kind === 'string' && update.kind !== ''
        ? update.kind
        : typeof update.title === 'string' && update.title !== ''
          ? update.title
          : memo.tool;
  }

  const target = readTarget(update);

  if (target !== undefined) {
    memo.target = target;
  }

  tools.set(id, memo);

  // A call is announced pending, before its arguments are settled, so reporting
  // it at that first sighting would show a tool acting on nothing.
  if (!memo.reported && status !== 'pending') {
    memo.reported = true;

    events.push({
      type: 'activity',
      id,
      tool: memo.tool,
      ...(memo.target !== undefined ? { target: memo.target } : {}),
    });
  }

  // A call refused here fails with the agent's own notice about it. Reporting that
  // as the call's output would say the refusal twice, and would credit it to the
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

/** Reads model ids from the JSON form, which is what --format json produces. */
function readModelJson(output: string): string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { models?: unknown }).models
      : undefined;

  if (!Array.isArray(list)) {
    return [];
  }

  const ids: string[] = [];

  for (const entry of list) {
    // `model_id` is what the listing reports. The other spellings are read too
    // because the same shape arrives from the session with ACP's own naming, and a
    // list that silently comes back empty would offer no models at all.
    const id =
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? ((entry as { model_id?: unknown }).model_id ??
            (entry as { modelId?: unknown }).modelId ??
            (entry as { id?: unknown }).id ??
            (entry as { model_name?: unknown }).model_name ??
            (entry as { name?: unknown }).name)
          : undefined;

    if (typeof id === 'string' && id !== '' && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}
