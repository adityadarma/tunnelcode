import { readActivityTarget } from '../activity.js';
import { isOnPath } from '../which.js';
import { startJsonRpc } from './json-rpc.js';
import type { RpcConnection, RpcRequest } from './json-rpc.js';
import type {
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'copilot';

/**
 * ACP revision this adapter speaks, which is the one the agent reports back on
 * initialize. Bumped only for a breaking change, so a mismatch is worth reporting
 * rather than working around.
 */
const PROTOCOL_VERSION = 1;

interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * One entry of a tool call's content, which arrives as an array.
 *
 * Either the tool's own output as text, or a diff describing a file it wrote.
 */
interface ToolCallContent {
  type?: unknown;
  content?: ContentBlock;
  path?: unknown;
  newText?: unknown;
}

interface ToolCallLocation {
  path?: unknown;
}

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
 * Reads the text of a content block. Only text is read: an image has no place in
 * a transcript that is relayed as text.
 */
function readText(content: ContentBlock | undefined): string {
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

/**
 * Picks what a tool call acted on.
 *
 * The arguments are preferred over the reported locations, because they are what a
 * permission rule is judged against: a shell call carries the command line it was
 * asked to run, and a file call carries the path. A location is the fallback for a
 * call that reports where it worked without saying how it was asked to.
 */
function readTarget(update: SessionUpdate): string | undefined {
  const fromInput = readActivityTarget(update.rawInput);

  if (fromInput !== undefined) {
    return fromInput;
  }

  const locations = Array.isArray(update.locations)
    ? (update.locations as ToolCallLocation[])
    : undefined;
  const found = locations?.find((entry) => typeof entry.path === 'string' && entry.path !== '');

  return typeof found?.path === 'string' ? found.path : undefined;
}

/**
 * Reads what a tool call reported.
 *
 * A diff is deliberately not read. It carries the whole new contents of a file and
 * an absolute path, where the activity already names the file as the workspace
 * sees it, so reading it would put a file body and a second path in the transcript.
 *
 * The agent's own result is the fallback, because a file write reports nothing as
 * content and only summarises itself there. Only its text is taken: the structured
 * half repeats the same thing.
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

  const raw = update.rawOutput;
  const content =
    typeof raw === 'object' && raw !== null ? (raw as { content?: unknown }).content : undefined;

  return typeof content === 'string' ? content : '';
}

/**
 * Reads the name to report the tool under.
 *
 * Copilot names no tool of its own over this surface: a call carries the ACP kind
 * it falls under and a title written for a person. The kind is preferred because it
 * is the same word for every call of that sort, which is what a permission rule on
 * this machine can be written against, where a title is a fresh sentence each time.
 */
function readToolName(update: SessionUpdate): string {
  if (typeof update.kind === 'string' && update.kind !== '') {
    return update.kind;
  }

  return typeof update.title === 'string' && update.title !== '' ? update.title : 'tool';
}

/**
 * The concrete operations one ask covers.
 *
 * A shell ask reports the commands the agent parsed out of the line it was given,
 * which can be several. Reported whole rather than summarised, because this is what
 * the user is agreeing to.
 */
function readDetails(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) {
    return [];
  }

  const commands = (input as { commands?: unknown }).commands;

  if (!Array.isArray(commands)) {
    return [];
  }

  return commands.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * Turns an ACP permission request into the shape the caller answers.
 *
 * What the call would do is read from the ask itself, which carries the whole tool
 * call rather than only a reference to one, and falls back to what was already
 * announced under that id.
 *
 * The options the agent offers are read rather than assumed: which of them exist
 * decides what an answer can be, and an agent offering no lasting grant cannot be
 * told to remember one.
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
  const tool = readToolName(call);
  const title = typeof call.title === 'string' && call.title !== '' ? call.title : tool;
  const target = readTarget(call) ?? announced?.target;
  const options = Array.isArray(record.options) ? (record.options as PermissionOption[]) : [];

  return {
    id,
    tool,
    title,
    ...(target !== undefined ? { target } : {}),
    details: readDetails(call.rawInput),
    // Offered only when the agent itself will remember the choice. Inventing a rule
    // here would promise a lasting grant the agent has no way to apply.
    suggestions: options.some((option) => option.kind === 'allow_always')
      ? [target !== undefined ? `${tool}(${target})` : tool]
      : [],
  };
}

/** The tool call an ask is about, so a refusal can be remembered against it. */
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
    // Refusing once is preferred over refusing for good: the answer is this call's,
    // and a lasting refusal is not what was decided.
    return byKind('reject_once') ?? byKind('reject_always') ?? '';
  }

  // 'always' is recorded on this machine rather than in the agent, so it allows on
  // the wire exactly as 'once' does. See ADR-022.
  return byKind('allow_once') ?? byKind('allow_always') ?? '';
}

/**
 * What is known about a tool call so far.
 *
 * Accumulated across updates because an update carries only what changed: a call
 * announced with its arguments is updated with a status and nothing else, and
 * reading each update alone would report an unnamed tool acting on nothing.
 */
interface ToolMemo {
  tool: string;
  target?: string;
  reported: boolean;
  /**
   * The output last reported for this call, so an unchanged repeat is dropped.
   *
   * A running shell is reported again on every update, with the output it has
   * produced so far. Each one is stored and broadcast as the call's output, and the
   * text only grows, so relaying the repeats writes the same value several times
   * over to arrive where the last one would have put it anyway.
   */
  output?: string;
  /**
   * Whether this call was refused here.
   *
   * Remembered because the agent then fails the call with a notice of its own. The
   * refusal is reported a level up, where the actual reason is known: a person may
   * have said no, or a limit on this machine may have, with nobody asked at all.
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
    const content = update.content;
    const text = readText(typeof content === 'object' && content !== null ? content : undefined);

    return text === '' ? [] : [{ type: 'delta', text }];
  }

  if (kind !== 'tool_call' && kind !== 'tool_call_update') {
    // Everything else Copilot reports is about the session rather than the turn:
    // the slash commands it offers, its settings, and how much of the context
    // window is spent. None of that is something the model said, worked out or did.
    //
    // The prompt also comes back as a user_message_chunk while a conversation is
    // being continued, which is the question rather than an answer to it.
    return [];
  }

  const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';

  if (id === '') {
    return [];
  }

  const events: EngineEvent[] = [];
  const status = update.status;
  const memo = tools.get(id) ?? { tool: 'tool', reported: false };

  // Filled rather than overwritten: the kind is announced once, and a later update
  // repeats neither it nor the arguments.
  if (memo.tool === 'tool') {
    memo.tool = readToolName(update);
  }

  const target = readTarget(update);

  if (target !== undefined) {
    memo.target = target;
  }

  tools.set(id, memo);

  // A call is announced pending, with the ask about it still to come, so reporting
  // it then would show the call as done before anyone had allowed it.
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
  // as the call's output would state the refusal twice, and would credit it to the
  // user even when a limit on this machine was what refused.
  if (memo.refused === true) {
    return events;
  }

  const output = readToolOutput(update);

  if (output !== '' && output !== memo.output) {
    memo.output = output;
    events.push({ type: 'activity_output', id, output });
  }

  // A call that failed for its own reasons still says so, since an answer that
  // works around a failed tool otherwise has no visible cause.
  if (status === 'failed' && output === '') {
    events.push({ type: 'activity_output', id, output: 'The tool call failed.' });
  }

  return events;
}

/** Reads the model ids a session reports it can answer with. */
function readModelIds(result: unknown): string[] {
  const models =
    typeof result === 'object' && result !== null
      ? (result as { models?: { availableModels?: unknown } }).models
      : undefined;
  const listed = models?.availableModels;

  if (!Array.isArray(listed)) {
    return [];
  }

  const ids: string[] = [];

  for (const entry of listed) {
    const id =
      typeof entry === 'object' && entry !== null
        ? (entry as { modelId?: unknown }).modelId
        : undefined;

    if (typeof id === 'string' && id !== '' && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

/**
 * GitHub Copilot CLI adapter.
 *
 * Driven through `copilot --acp`, which speaks the Agent Client Protocol over
 * stdio: JSON-RPC, one object per line. Chosen over `copilot -p`, whose
 * non-interactive mode requires `--allow-all-tools` and so approves every tool call
 * on the agent's behalf, which is what the limits set on this machine exist to
 * prevent. Over ACP the agent asks, and the ask reaches the browser. See ADR-022.
 *
 * Text arrives as `agent_message_chunk`. Nothing is reported as reasoning: Copilot
 * counts its thinking in the token usage it returns but streams none of it, so
 * there is no thinking here to relay. See ADR-037.
 *
 * A call carries no tool name of its own, only the ACP kind it falls under, so that
 * is what an activity and a permission rule are named after.
 */
export class CopilotEngine implements Engine {
  readonly name = 'copilot';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Reads the models from a session, which is the only surface that reports them:
   * the CLI has no listing command, and `initialize` answers without one.
   *
   * The session opened here is thrown away with the connection. Nothing is prompted
   * into it, so it costs a process and no tokens.
   *
   * An empty list is read as "use the engine default" rather than as a failure, so a
   * machine that is not logged in is still offered the engine once someone logs in.
   * The login is never checked by running `copilot login`, which would open a
   * browser and wait for it during discovery.
   */
  async listModels(): Promise<string[]> {
    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(COMMAND, ['--acp'], process.cwd(), {
        onRequest: () => Promise.reject(new Error('Nothing is asked of a listing.')),
        onNotification: () => {
          // A listing has no turn, so the session's own notifications are not this
          // method's business.
        },
        onStderr: () => {
          // Diagnostics belong to a turn. Listing models has no transcript to put
          // them in, and a warning here is not a reason to offer no models.
        },
        onExit: () => {
          // The request below already fails when the process goes early, which is
          // what reports it.
        },
      });

      await connection.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });

      return readModelIds(
        await connection.request('session/new', { cwd: process.cwd(), mcpServers: [] }),
      );
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
   * Runs the prompt, retrying once without the session id when Copilot cannot find
   * it.
   *
   * A stale id is expected rather than exceptional: sessions live in Copilot's own
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
      const resumeReader = notify;
      notify = undefined;
      resumeReader?.();
    };

    /**
     * Whether the agent is replaying history rather than producing it.
     *
     * Continuing a conversation replays every earlier message as an ordinary
     * update, so nothing is relayed while that happens: the transcript is already
     * stored here, and relaying it would repeat the whole conversation inside this
     * one answer.
     */
    let replaying = false;
    const tools = new Map<string, ToolMemo>();

    /** Answers one ask, once the caller has decided. */
    const decide = async (request: RpcRequest): Promise<unknown> => {
      const params = request.params;
      const offeredRaw =
        typeof params === 'object' && params !== null
          ? ((params as { options?: unknown }).options ?? [])
          : [];
      const offered = Array.isArray(offeredRaw) ? (offeredRaw as PermissionOption[]) : [];
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
      // the turn was cancelled, which is the only other outcome ACP defines.
      return optionId === ''
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } };
    };

    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(COMMAND, ['--acp'], options.cwd, {
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
          push({ type: 'error', message: 'Copilot ended before finishing the turn.' });
          push({ type: 'done', exitCode: 1 });
          push(null);
        },
      });
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot start Copilot.',
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

          const record = typeof result === 'object' && result !== null ? result : {};
          const stopReason = (record as { stopReason?: unknown }).stopReason;
          const usage = (record as { usage?: { inputTokens?: unknown; outputTokens?: unknown } })
            .usage;

          if (
            usage !== undefined &&
            typeof usage.inputTokens === 'number' &&
            typeof usage.outputTokens === 'number'
          ) {
            push({
              type: 'usage',
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            });
          }

          // Claimed before anything is reported, so the exit that follows a turn
          // ending normally is not announced as a turn that never finished.
          finished = true;

          // refusal is the agent declining to continue, which is a turn that
          // produced no answer rather than a crash.
          if (stopReason === 'refusal') {
            push({ type: 'error', message: 'Copilot refused to continue this turn.' });
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
        push({
          type: 'error',
          message: error instanceof Error ? error.message : 'Copilot reported an error.',
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
 * A conversation is continued with `session/load`, which replays the whole
 * transcript before it returns, which is why the caller stops relaying updates
 * until it does. A session id Copilot cannot find is reported as a resource that
 * does not exist, and the caller starts a new one rather than losing the turn.
 */
async function openSession(
  connection: RpcConnection,
  options: PromptOptions,
  resume: string | undefined,
): Promise<string> {
  if (resume !== undefined) {
    // The response carries no id of its own: the session loaded is the one asked
    // for, reported back with the models it can answer with.
    await connection.request('session/load', {
      sessionId: resume,
      cwd: options.cwd,
      mcpServers: [],
    });

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
    throw new Error('Copilot started a session with no id.');
  }

  return id;
}

/**
 * Asks the session to answer with a chosen model.
 *
 * Told to the session rather than passed on the command line, because a continued
 * conversation would otherwise keep whatever model it was created with, and a model
 * changed in the browser would never take effect.
 *
 * Returns what went wrong instead of throwing. A model the agent will not take is a
 * preference, and losing an otherwise working turn over it would be worse than
 * answering on the default.
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
    return `Copilot would not answer with ${model}: ${
      error instanceof Error ? error.message : 'the model was refused'
    }. Answering with its default instead.`;
  }
}
