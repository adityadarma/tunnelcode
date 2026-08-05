import { readActivityTarget } from '../activity.js';
import { captureOutput, isOnPath } from '../which.js';
import { RpcFailure, startJsonRpc } from './json-rpc.js';
import type { RpcConnection, RpcRequest } from './json-rpc.js';
import type {
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'codex';

/**
 * How this client introduces itself on `initialize`.
 *
 * The version is the client's own and not this project's release: the engine
 * package has no access to the CLI's version, and the field only ends up in a user
 * agent string. Naming a release here would be a number nobody could act on.
 */
const CLIENT_INFO = { name: 'tunnelcode', version: '1' } as const;

/**
 * When Codex has to ask before it acts.
 *
 * `on-request` is what lets a call reach the browser at all. `never` would have the
 * agent decide alone, which is what the limits set on this machine exist to
 * prevent, and `untrusted` asks about every command including the ones it would
 * run inside the sandbox anyway, which would put a card on the phone for each `ls`.
 * See ADR-048.
 */
const APPROVAL_POLICY = 'on-request';

/**
 * What Codex may do without asking.
 *
 * `read-only` is the tightest of the three that still lets the agent work: it can
 * read the workspace and run commands that only read, and anything that writes or
 * reaches the network becomes an ask. `workspace-write` would let it change files
 * in the workspace unasked, and `danger-full-access` is the setting this project
 * exists to avoid. See ADR-048.
 */
const SANDBOX = 'read-only';

/**
 * How Codex words a missing login on stderr.
 *
 * Read as well as any error code because the refusal can arrive before a request is
 * answered, in which case the process exits and no code ever comes back.
 */
const NOT_LOGGED_IN = /not logged in|please (?:run )?codex login/i;

/**
 * How a refusal for want of a login reads in a JSON-RPC error.
 *
 * Matched against the agent's own wording so a quota, a rate limit or an internal
 * error is reported as itself. Read as a login problem, every one of them would
 * send the user back to `codex login` to fix something a login cannot fix.
 */
const AUTH_MESSAGE = /not logged in|log ?in|unauthenticated|authenticat|credential|expired token/i;

/** Explains a missing login in terms of the command that fixes it. */
const LOGIN_MESSAGE = 'Codex is not logged in. Run codex login on this machine, then try again.';

/** Tool names, as Codex's own settings and this project's rules would name them. */
const SHELL_TOOL = 'shell';
const PATCH_TOOL = 'apply_patch';

interface ThreadItem {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  /** commandExecution */
  command?: unknown;
  commandActions?: unknown;
  aggregatedOutput?: unknown;
  exitCode?: unknown;
  status?: unknown;
  /** fileChange */
  changes?: unknown;
  /** mcpToolCall and dynamicToolCall */
  tool?: unknown;
  server?: unknown;
  arguments?: unknown;
  /** reasoning */
  summary?: unknown;
  content?: unknown;
  /** webSearch */
  query?: unknown;
  /** imageView */
  path?: unknown;
}

interface CommandAction {
  command?: unknown;
}

interface FileUpdateChange {
  path?: unknown;
}

/**
 * What is known about one item of a turn.
 *
 * Kept because an approval request names only the item it is about: a file change
 * ask carries no paths at all, so read alone it would reach the phone as an unnamed
 * tool acting on nothing, and no rule on this machine could match it.
 */
interface ToolMemo {
  tool: string;
  target?: string;
  /** The concrete operations the item covers, for a rule to be judged against. */
  details: string[];
  reported: boolean;
  /**
   * Whether an ask about this call was raised to the caller.
   *
   * Remembered because a refused call then comes back marked `declined`, and
   * reporting that would state the refusal twice and credit it to the engine when a
   * person, or a limit on this machine, is what refused.
   *
   * Recorded when the ask arrives rather than when it is answered. Deciding means
   * waiting for someone, and the app server sends the declined item as soon as it
   * has the answer, so the two race: keyed on the decision this reported a refusal
   * twice or not at all depending on which won.
   */
  asked?: boolean;
}

/** How a turn ended, as the notification that ended it described it. */
type TurnOutcome = { ok: true } | { ok: false; message: string };

/** Reads the commands Codex parsed out of a command line, for display and rules. */
function readCommandActions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const commands: string[] = [];

  for (const entry of value as CommandAction[]) {
    if (typeof entry.command === 'string' && entry.command.trim() !== '') {
      commands.push(entry.command.replace(/\s+/g, ' ').trim());
    }
  }

  return [...new Set(commands)];
}

/** The files a patch touches, in the order Codex reported them. */
function readChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const paths: string[] = [];

  for (const entry of value as FileUpdateChange[]) {
    if (typeof entry.path === 'string' && entry.path.trim() !== '') {
      paths.push(entry.path.trim());
    }
  }

  return [...new Set(paths)];
}

/** Joins the text of a reasoning item, which arrives as a list of blocks. */
function readTextList(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join('\n')
    : '';
}

/**
 * What an item is, in the vocabulary a permission rule on this machine is written
 * in.
 *
 * Returns undefined for the items that are not work: the prompt coming back, the
 * answer, and the model's own deliberation all arrive as items too, and reporting
 * those as activities would put the conversation in the timeline twice.
 */
function readMemo(item: ThreadItem): ToolMemo | undefined {
  const type = item.type;

  if (type === 'commandExecution') {
    // The raw line, not the parsed commands: this is what actually runs, and
    // ADR-025 keeps what a rule is judged against whole.
    const command =
      typeof item.command === 'string' ? item.command.replace(/\s+/g, ' ').trim() : '';
    const actions = readCommandActions(item.commandActions);

    return {
      tool: SHELL_TOOL,
      ...(command !== '' ? { target: command } : {}),
      // The commands inside the line as well as the line itself, because one ask
      // can cover several and agreeing to one of them would mean agreeing to all.
      details: actions,
      reported: false,
    };
  }

  if (type === 'fileChange') {
    const paths = readChangedPaths(item.changes);

    return {
      tool: PATCH_TOOL,
      ...(paths.length > 0 ? { target: paths.join(', ') } : {}),
      details: paths,
      reported: false,
    };
  }

  if (type === 'mcpToolCall' || type === 'dynamicToolCall') {
    const tool = typeof item.tool === 'string' && item.tool !== '' ? item.tool : 'tool';
    const target = readActivityTarget(item.arguments);
    const server = typeof item.server === 'string' && item.server !== '' ? item.server : undefined;

    return {
      tool,
      ...(target !== undefined ? { target } : server !== undefined ? { target: server } : {}),
      details: target !== undefined ? [target] : [],
      reported: false,
    };
  }

  if (type === 'webSearch') {
    const query = typeof item.query === 'string' ? item.query.trim() : '';

    return {
      tool: 'web_search',
      ...(query !== '' ? { target: query } : {}),
      details: query === '' ? [] : [query],
      reported: false,
    };
  }

  if (type === 'imageView') {
    const path = typeof item.path === 'string' ? item.path.trim() : '';

    return {
      tool: 'view_image',
      ...(path !== '' ? { target: path } : {}),
      details: path === '' ? [] : [path],
      reported: false,
    };
  }

  return undefined;
}

/** What a completed item produced, if it produced anything worth showing. */
function readItemOutput(item: ThreadItem): string {
  if (item.type === 'commandExecution') {
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trimEnd() : '';

    if (output !== '') {
      return output;
    }

    // A command that printed nothing still says how it went, since an answer that
    // works around a failed command otherwise has no visible cause.
    return typeof item.exitCode === 'number' && item.exitCode !== 0
      ? `Exited with code ${String(item.exitCode)}.`
      : '';
  }

  // A patch is deliberately not read. Its diff carries the whole new contents of
  // every file it touches, and the activity already names them.
  if (item.type === 'fileChange') {
    return '';
  }

  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const result = (item as { result?: unknown }).result;
    return typeof result === 'string' ? result.trimEnd() : '';
  }

  return '';
}

/**
 * Codex CLI adapter.
 *
 * Driven through `codex app-server`, which speaks JSON-RPC over stdio: one object
 * per line, the same framing Kiro's ACP uses, so the transport is shared. Chosen
 * over `codex exec --json` because that surface has no channel to ask about a tool
 * call: it decides alone from its sandbox and approval policy, so a call it will
 * not make is refused and nobody is ever asked. See ADR-048.
 *
 * The app server asks over `item/commandExecution/requestApproval` and
 * `item/fileChange/requestApproval`, so a call the agent will not make alone
 * reaches the browser and the answer returns to the turn that asked. See ADR-022.
 *
 * Text arrives as `item/agentMessage/delta`. Thinking arrives as
 * `item/reasoning/summaryTextDelta` and is reported as reasoning rather than as
 * answer text: it is the model working itself out, so it belongs beside the answer
 * rather than inside it. See ADR-037.
 */
export class CodexEngine implements Engine {
  readonly name = 'codex';
  readonly command = COMMAND;

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /**
   * Whether anyone is logged in.
   *
   * Asked with `login status`, which answers the question rather than trying to fix
   * it: it says nobody is logged in and exits nonzero, without opening a browser.
   *
   * Read from the exit status rather than the wording. Both answers are written to
   * stderr, so a check against what it said matched neither of them and reported
   * every machine as logged out, which offered no models on a machine that had them.
   */
  private async isLoggedIn(): Promise<boolean> {
    return (await captureOutput(COMMAND, ['login', 'status'])) !== undefined;
  }

  /**
   * Reads the model list from the app server's own `model/list`.
   *
   * The login is checked first because a machine with nobody logged in has no model
   * list to report, and starting the app server to be told so is work with no
   * answer at the end of it.
   *
   * An empty list is read as "use the engine default" rather than as a failure, so
   * the engine is still offered once someone logs in.
   */
  async listModels(): Promise<string[]> {
    if (!(await this.isLoggedIn())) {
      return [];
    }

    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(COMMAND, ['app-server'], process.cwd(), {
        onRequest: () => Promise.reject(new Error('Nothing is asked of a listing.')),
        onNotification: () => {
          // A listing has no turn, so the app server's status notifications are
          // not this method's business.
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

      await connection.request('initialize', { clientInfo: CLIENT_INFO });

      // Hidden models are left out: they are the ones Codex keeps out of its own
      // picker, so offering them would put a choice in the browser that the engine
      // does not consider current.
      const listed = await connection.request('model/list', { includeHidden: false });

      return readModelIds(listed);
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
   * Runs the prompt, retrying once without the thread id when resuming was refused.
   *
   * A stale id is expected rather than exceptional: threads live in Codex's own
   * store under `~/.codex/sessions` and can be pruned at any time. Answering
   * without the earlier context is better than refusing to answer at all.
   */
  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    if (options.resume !== undefined) {
      const buffered: EngineEvent[] = [];
      let committed = false;
      let stale = false;

      for await (const event of this.attempt(text, options, options.resume)) {
        // Anything the engine produced means the thread was found, so from here on
        // the run is passed straight through.
        if (event.type !== 'log' && event.type !== 'done' && event.type !== 'error') {
          committed = true;
        }

        if (!committed && event.type === 'error') {
          stale = true;
          continue;
        }

        // A failure caused by the missing thread is not worth reporting when the
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

  /** One engine run, with or without a thread to continue. */
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

    const tools = new Map<string, ToolMemo>();

    /**
     * Items whose text arrived as fragments.
     *
     * Tracked so the finished item is not emitted on top of the fragments it was
     * assembled from, while an item that never streamed is still shown.
     */
    const streamed = new Set<string>();

    /**
     * Whether the prompt has been sent.
     *
     * Read to tell this turn's token usage from the conversation's, which arrives
     * beforehand when a thread is resumed.
     */
    let promptSent = false;
    let inputTokens = 0;
    let outputTokens = 0;

    let settle: (outcome: TurnOutcome) => void = () => {
      // Replaced below, before anything can end the turn.
    };
    const completion = new Promise<TurnOutcome>((resolve) => {
      settle = resolve;
    });

    /** Answers one ask, once the caller has decided. */
    const decide = async (request: RpcRequest, kind: 'shell' | 'patch'): Promise<boolean> => {
      const itemId = readAskedItemId(request.params);

      // Claimed before anyone is asked, so the declined item that follows a refusal
      // is recognised as this ask's outcome however the two are ordered.
      if (itemId !== '') {
        const known = tools.get(itemId);

        if (known === undefined) {
          // An ask can arrive before the item that announced the call, in which case
          // this is the first thing known about it.
          tools.set(itemId, {
            tool: kind === 'patch' ? PATCH_TOOL : SHELL_TOOL,
            details: [],
            reported: false,
            asked: true,
          });
        } else {
          known.asked = true;
        }
      }

      const ask = readPermissionRequest(String(request.id), request.params, kind, tools);
      const requestPermission = options.requestPermission;

      // Refusal is the fallback whenever nobody can answer, because the alternative
      // is running a tool call nobody agreed to.
      let decision: EnginePermissionDecision = 'reject';

      if (requestPermission !== undefined) {
        try {
          decision = await requestPermission(ask);
        } catch {
          decision = 'reject';
        }
      }

      return decision !== 'reject';
    };

    let connection: RpcConnection | undefined;

    try {
      connection = await startJsonRpc(COMMAND, ['app-server'], options.cwd, {
        onRequest: async (request) => {
          // 'always' is recorded on this machine rather than in the agent, so it is
          // answered on the wire exactly as 'once' is. Codex's own
          // `acceptForSession` would keep a grant this project cannot see or clear,
          // and its execpolicy amendments are written in a language of its own.
          // See ADR-022.
          if (request.method === 'item/commandExecution/requestApproval') {
            return { decision: (await decide(request, 'shell')) ? 'accept' : 'decline' };
          }

          if (request.method === 'item/fileChange/requestApproval') {
            return { decision: (await decide(request, 'patch')) ? 'accept' : 'decline' };
          }

          // The older spellings of the same two questions, kept because a Codex
          // that raises them would otherwise have its asks refused as unsupported.
          if (request.method === 'execCommandApproval') {
            return { decision: (await decide(request, 'shell')) ? 'approved' : 'denied' };
          }

          if (request.method === 'applyPatchApproval') {
            return { decision: (await decide(request, 'patch')) ? 'approved' : 'denied' };
          }

          // Anything else is a question this adapter cannot answer honestly, and a
          // profile or an elicitation answered by guessing would grant something
          // nobody agreed to. Refusing loudly leaves the agent to carry on without
          // it. See ADR-048.
          throw new Error(`Unsupported request: ${request.method}`);
        },

        onNotification: (method, params) => {
          if (method === 'turn/completed') {
            // Not matched against the turn's own id. One connection drives one
            // thread and one turn, so any completion arriving here is this one's,
            // and the id would have to be compared against a variable assigned in a
            // continuation that has not necessarily run: an app server that answers
            // `turn/start` and finishes the turn in the same write would be filtered
            // out by its own speed, and the turn would wait for an ending already
            // announced.
            const failure = readTurnFailure(params);
            settle(failure === undefined ? { ok: true } : { ok: false, message: failure });
            return;
          }

          if (method === 'error') {
            // A failure the agent intends to retry is not the turn ending, and
            // reporting it as one would end a turn that is still working.
            if (readWillRetry(params)) {
              const message = readErrorMessage(params);

              if (message !== '') {
                push({ type: 'log', text: message });
              }
              return;
            }

            settle({ ok: false, message: readErrorMessage(params) });
            return;
          }

          if (method === 'thread/tokenUsage/updated') {
            // Only what this turn spent. Resuming a thread reports the totals it
            // already had before the prompt is sent, so counting those would bill
            // this answer for every earlier one in the conversation.
            if (!promptSent) {
              return;
            }

            const usage = readLastUsage(params);
            inputTokens += usage.inputTokens;
            outputTokens += usage.outputTokens;
            return;
          }

          for (const event of mapNotification(method, params, tools, streamed)) {
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
          // Reached when the app server ends on its own, which is a turn that will
          // never be answered. Ending it here rather than waiting is what stops the
          // turn hanging on a process that has already gone.
          if (finished) {
            return;
          }

          settle({
            ok: false,
            message: needsLogin ? LOGIN_MESSAGE : 'Codex ended before finishing the turn.',
          });
        },
      });
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot start Codex.',
      };
      yield { type: 'done', exitCode: 127 };
      return;
    }

    const live = connection;

    /** Drives the turn, pushing what it learns onto the same queue as the updates. */
    const turn = async (): Promise<void> => {
      try {
        await live.request('initialize', { clientInfo: CLIENT_INFO });

        const threadId = await openThread(live, options, resume);

        // Reported before any answer, so a run cut short still leaves an id to
        // continue from.
        push({ type: 'session', id: threadId });

        promptSent = true;

        const started = await live.request('turn/start', {
          threadId,
          input: [{ type: 'text', text }],
          // Told per turn rather than per thread, so a model changed in the browser
          // takes effect on a conversation that already exists.
          ...(options.model !== undefined && options.model !== '' ? { model: options.model } : {}),
        });

        const turnId = readStartedTurnId(started);

        const cancel = (): void => {
          void live.request('turn/interrupt', { threadId, turnId }).catch(() => {
            // A turn that has already ended cannot be interrupted, and saying so
            // would report a stop that worked as a failure.
          });
        };

        options.signal?.addEventListener('abort', cancel, { once: true });

        try {
          // `turn/start` answers as soon as the turn is accepted, not when it is
          // over, so the outcome comes from the notification that ends it.
          const outcome = await completion;

          finished = true;

          if (inputTokens > 0 || outputTokens > 0) {
            push({ type: 'usage', inputTokens, outputTokens });
          }

          if (!outcome.ok) {
            push({ type: 'error', message: outcome.message });
            push({ type: 'done', exitCode: 1 });
            return;
          }

          push({ type: 'done', exitCode: 0 });
        } finally {
          options.signal?.removeEventListener('abort', cancel);
        }
      } catch (error) {
        // The exit handler may have reported this already: an app server that dies
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
              : 'Codex reported an error.',
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
      // The app server holds a thread open per connection, so leaving it running
      // would keep an agent with access to the workspace alive after the turn
      // ended. See ADR-044.
      connection.close();
    }
  }
}

/**
 * Opens the thread to prompt into.
 *
 * The approval policy and the sandbox are named on the thread rather than left to
 * the user's `config.toml`, because they are what decides whether a call is asked
 * about or decided by the engine alone. Read from the file they would be a limit
 * this project states and does not set. See ADR-048.
 */
async function openThread(
  connection: RpcConnection,
  options: PromptOptions,
  resume: string | undefined,
): Promise<string> {
  const settings = {
    cwd: options.cwd,
    approvalPolicy: APPROVAL_POLICY,
    sandbox: SANDBOX,
  };

  if (resume !== undefined) {
    const resumed = await connection.request('thread/resume', { threadId: resume, ...settings });

    // The id is the one that was asked for. A resume that reported a different
    // thread would be a different conversation, so the response is only read to
    // confirm it answered at all.
    void resumed;
    return resume;
  }

  const created = await connection.request('thread/start', settings);
  const id = readThreadId(created);

  if (id === '') {
    throw new Error('Codex started a thread with no id.');
  }

  return id;
}

/** The thread id from a `thread/start` response. */
function readThreadId(result: unknown): string {
  const thread =
    typeof result === 'object' && result !== null
      ? (result as { thread?: { id?: unknown } }).thread
      : undefined;

  return typeof thread?.id === 'string' ? thread.id : '';
}

/** The turn id from a `turn/start` response. */
function readStartedTurnId(result: unknown): string {
  const turn =
    typeof result === 'object' && result !== null
      ? (result as { turn?: { id?: unknown } }).turn
      : undefined;

  return typeof turn?.id === 'string' ? turn.id : '';
}

/**
 * Why a completed turn failed, or undefined when it did not.
 *
 * An interrupted turn is not a failure: it is a turn the caller stopped, and
 * describing a stop the user asked for as a failure is a lie the transcript would
 * keep repeating. See ADR-042.
 */
function readTurnFailure(params: unknown): string | undefined {
  const turn =
    typeof params === 'object' && params !== null
      ? (params as { turn?: { status?: unknown; error?: unknown } }).turn
      : undefined;

  if (turn === undefined) {
    return undefined;
  }

  const error = turn.error;
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;

  if (typeof message === 'string' && message.trim() !== '') {
    return message.trim();
  }

  return turn.status === 'failed' ? 'Codex ended the turn without answering.' : undefined;
}

function readWillRetry(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    (params as { willRetry?: unknown }).willRetry === true
  );
}

function readErrorMessage(params: unknown): string {
  const error =
    typeof params === 'object' && params !== null
      ? (params as { error?: unknown }).error
      : undefined;
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;

  return typeof message === 'string' && message.trim() !== ''
    ? message.trim()
    : 'Codex reported an error.';
}

/**
 * The tokens the last model request spent.
 *
 * `last` rather than `total`: the total is the whole thread's, across every turn it
 * has ever had, so reporting it would grow with the conversation instead of
 * describing this answer. Summed across the notifications of one turn, which is
 * what a turn that made several requests costs.
 */
function readLastUsage(params: unknown): { inputTokens: number; outputTokens: number } {
  const usage =
    typeof params === 'object' && params !== null
      ? (params as { tokenUsage?: { last?: unknown } }).tokenUsage?.last
      : undefined;
  const last =
    typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
  const input = last['inputTokens'];
  const output = last['outputTokens'];

  return {
    inputTokens: typeof input === 'number' ? input : 0,
    outputTokens: typeof output === 'number' ? output : 0,
  };
}

/** The item an ask is about, which for a file change is all the ask says. */
function readAskedItemId(params: unknown): string {
  if (typeof params !== 'object' || params === null) {
    return '';
  }

  const record = params as { itemId?: unknown; callId?: unknown };

  if (typeof record.itemId === 'string') {
    return record.itemId;
  }

  // The older spellings name the call rather than the item.
  return typeof record.callId === 'string' ? record.callId : '';
}

/**
 * Turns an approval request into the shape the caller answers.
 *
 * What the call would do is taken from the ask when it says, and from what was
 * already announced about the item when it does not: a file change ask carries only
 * ids, so read alone it would reach the phone as an unnamed tool acting on nothing.
 *
 * No suggestions are offered. Codex has a lasting grant of its own, but it is
 * spelled either as a session cache this project cannot see or clear, or as an
 * execpolicy amendment written in Codex's own language, and a rule translated from
 * it would mean something other than what the user agreed to. With none offered the
 * caller records the operations literally, which covers what was actually allowed
 * and nothing more. See ADR-022.
 */
function readPermissionRequest(
  id: string,
  params: unknown,
  kind: 'shell' | 'patch',
  tools: Map<string, ToolMemo>,
): EnginePermissionRequest {
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};
  const announced = tools.get(readAskedItemId(params));

  const reason = typeof record['reason'] === 'string' ? record['reason'].trim() : '';

  if (kind === 'patch') {
    const target = announced?.target;

    return {
      id,
      tool: PATCH_TOOL,
      title: target === undefined ? 'Edit files' : `Edit ${target}`,
      ...(target !== undefined ? { target } : {}),
      ...(reason !== '' ? { reason } : {}),
      details: announced?.details ?? [],
      suggestions: [],
    };
  }

  // A command ask describes itself, so the ask is preferred over the memo: it is
  // the line about to run, where the memo may still hold the one before it.
  const command = readAskedCommand(record) ?? announced?.target;
  const actions = readCommandActions(record['commandActions']);
  const details = actions.length > 0 ? actions : (announced?.details ?? []);

  return {
    id,
    tool: SHELL_TOOL,
    title: command === undefined ? 'Run a command' : `Run ${command}`,
    ...(command !== undefined ? { target: command } : {}),
    ...(reason !== '' ? { reason } : {}),
    details,
    suggestions: [],
  };
}

/**
 * The command line an ask is about.
 *
 * The newer spelling carries it as a string. The older one carries the argv the
 * agent will execute, which is joined rather than reported as a list, because a
 * rule on this machine is matched against one line.
 */
function readAskedCommand(record: Record<string, unknown>): string | undefined {
  const command = record['command'];

  if (typeof command === 'string' && command.trim() !== '') {
    return command.replace(/\s+/g, ' ').trim();
  }

  if (Array.isArray(command)) {
    const argv = command.filter((part): part is string => typeof part === 'string');

    return argv.length === 0 ? undefined : argv.join(' ');
  }

  return undefined;
}

/** Maps one notification onto engine events. */
function mapNotification(
  method: string,
  params: unknown,
  tools: Map<string, ToolMemo>,
  streamed: Set<string>,
): EngineEvent[] {
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {};

  if (method === 'item/agentMessage/delta') {
    const delta = record['delta'];
    const itemId = record['itemId'];

    if (typeof itemId === 'string') {
      streamed.add(itemId);
    }

    return typeof delta === 'string' && delta !== '' ? [{ type: 'delta', text: delta }] : [];
  }

  // Thinking, not the answer. Reported as its own event so the reader is never
  // shown the model working itself out as though it were speaking to them, and can
  // still open it when they want to see the working. See ADR-037.
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const delta = record['delta'];
    const itemId = record['itemId'];

    if (typeof itemId === 'string') {
      streamed.add(itemId);
    }

    return typeof delta === 'string' && delta !== '' ? [{ type: 'reasoning', text: delta }] : [];
  }

  if (method !== 'item/started' && method !== 'item/completed') {
    return [];
  }

  const item =
    typeof record['item'] === 'object' && record['item'] !== null
      ? (record['item'] as ThreadItem)
      : undefined;

  if (item === undefined) {
    return [];
  }

  const id = typeof item.id === 'string' ? item.id : '';

  if (id === '') {
    return [];
  }

  const completed = method === 'item/completed';

  // The answer and the deliberation stream as fragments. Only an item that never
  // streamed is read from here, which is what a provider answering in one piece
  // produces, and it is the difference between a silent turn and a visible one.
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text : '';

    return completed && !streamed.has(id) && text !== '' ? [{ type: 'delta', text }] : [];
  }

  if (item.type === 'reasoning') {
    const summary = readTextList(item.summary);
    const text = summary !== '' ? summary : readTextList(item.content);

    return completed && !streamed.has(id) && text !== '' ? [{ type: 'reasoning', text }] : [];
  }

  const memo = tools.get(id) ?? readMemo(item);

  if (memo === undefined) {
    return [];
  }

  // Everything learned about the item so far. A started item already carries its
  // arguments, and the completed one repeats them alongside the result, so the
  // later sighting only fills what the first did not know.
  const fresh = readMemo(item);

  if (fresh !== undefined) {
    if (fresh.target !== undefined) {
      memo.target = fresh.target;
    }
    if (fresh.details.length > 0) {
      memo.details = fresh.details;
    }
  }

  tools.set(id, memo);

  const events: EngineEvent[] = [];

  if (!memo.reported) {
    memo.reported = true;

    events.push({
      type: 'activity',
      id,
      tool: memo.tool,
      ...(memo.target !== undefined ? { target: memo.target } : {}),
    });
  }

  if (!completed) {
    return events;
  }

  // A call that was asked about is the caller's to report, since it is the only side
  // that knows whether a person said no, a limit on this machine did, or nobody
  // answered. Codex words a refused call as declined either way.
  if (memo.asked === true) {
    return events;
  }

  const output = readItemOutput(item);

  if (output !== '') {
    events.push({ type: 'activity_output', id, output });
  }

  // A call Codex declined without asking about it, which its sandbox and approval
  // policy can do on their own. Reported here because nothing else saw it refused,
  // and the answer that works around it would otherwise have no visible cause.
  // See ADR-022.
  if (item.status === 'declined') {
    events.push({
      type: 'blocked',
      tool: memo.tool,
      reason: 'Refused by Codex, whose sandbox and approval policy decided alone.',
    });
  }

  return events;
}

/**
 * Reads model ids from a `model/list` response.
 *
 * `id` is what `--model` and the thread settings accept. The display name is not
 * read: a model has to be named the way the engine will take it back.
 */
function readModelIds(result: unknown): string[] {
  const data =
    typeof result === 'object' && result !== null ? (result as { data?: unknown }).data : undefined;

  if (!Array.isArray(data)) {
    return [];
  }

  const ids: string[] = [];

  for (const entry of data as { id?: unknown; model?: unknown; hidden?: unknown }[]) {
    if (entry.hidden === true) {
      continue;
    }

    const id =
      typeof entry.id === 'string' && entry.id !== ''
        ? entry.id
        : typeof entry.model === 'string'
          ? entry.model
          : '';

    if (id !== '' && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}
