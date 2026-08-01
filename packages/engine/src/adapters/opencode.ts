import { captureOutput, isOnPath } from '../which.js';
import { readActivityTarget } from '../activity.js';
import { startOpenCodeServer } from './opencode-server.js';
import type { OpenCodeServerHandle, StartOpenCodeServer } from './opencode-server.js';
import type {
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';

const COMMAND = 'opencode';

/** A model id looks like provider/model, which is what opencode reports. */
const MODEL_PATTERN = /^[\w.-]+\/[\w./-]+$/;

/**
 * Title given to a session the adapter starts.
 *
 * Never shown to the user, since the conversation carries its own title. Supplied
 * so opencode does not spend the first turn inventing one.
 */
const SESSION_TITLE = 'tunnelcode';

/**
 * How opencode words a tool call it refused on permission grounds.
 *
 * Only consulted when nobody can be asked, which is the one case where opencode
 * decides by itself.
 */
const PERMISSION_PATTERN = /rejected permission|permission requested|requires approval/i;

const REASON_MAX_LENGTH = 200;

function shortenReason(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= REASON_MAX_LENGTH ? flat : `${flat.slice(0, REASON_MAX_LENGTH - 1)}…`;
}

interface ToolState {
  status?: unknown;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

interface EventPart {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  callID?: unknown;
  messageID?: unknown;
  state?: ToolState;
}

interface EventProperties {
  sessionID?: unknown;
  messageID?: unknown;
  partID?: unknown;
  field?: unknown;
  delta?: unknown;
  part?: EventPart;
  info?: { id?: unknown; role?: unknown; parentID?: unknown };
  error?: unknown;
  /** Carried by a permission ask. */
  id?: unknown;
  permission?: unknown;
  patterns?: unknown;
  always?: unknown;
  metadata?: { command?: unknown };
}

interface ServerEvent {
  type?: unknown;
  properties?: EventProperties;
}

function readStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Turns a permission ask into the shape the caller answers. */
function readPermissionRequest(properties: EventProperties): EnginePermissionRequest | undefined {
  const id = typeof properties.id === 'string' ? properties.id : '';
  const tool = typeof properties.permission === 'string' ? properties.permission : '';

  if (id === '' || tool === '') {
    return undefined;
  }

  const command =
    typeof properties.metadata?.command === 'string' ? properties.metadata.command : '';

  return {
    id,
    tool,
    title: tool,
    ...(command !== '' ? { target: command } : {}),
    // opencode can cover several commands with one ask, which is why details is a
    // list rather than a single string. See ADR-022.
    details: readStrings(properties.patterns),
    // Reworded into the rule syntax the machine stores grants in, since opencode
    // offers bare globs with the tool left implied.
    suggestions: readStrings(properties.always).map((glob) => `${tool}(${glob})`),
  };
}

/**
 * OpenCode adapter.
 *
 * Driven as a client of a headless server rather than through `opencode run`:
 * that command answers permission asks itself, and it answers by rejecting them,
 * which nothing around it can intercept. See ADR-022.
 *
 * Text arrives as `message.part.delta` fragments. The full-text form of a part is
 * used only as a fallback, because a part that streamed would otherwise be
 * emitted twice.
 */
export class OpenCodeEngine implements Engine {
  readonly name = 'opencode';
  readonly command = COMMAND;

  private readonly startServer: StartOpenCodeServer;
  private server: OpenCodeServerHandle | undefined;
  private serverCwd: string | undefined;

  constructor(options: { startServer?: StartOpenCodeServer } = {}) {
    this.startServer = options.startServer ?? startOpenCodeServer;
  }

  async isAvailable(): Promise<boolean> {
    return isOnPath(COMMAND);
  }

  /** Reads the model list from `opencode models`, one id per line. */
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

  /** Stops the server this adapter started, if any. */
  stop(): void {
    this.server?.stop();
    this.server = undefined;
    this.serverCwd = undefined;
  }

  /**
   * The server for a workspace, started on first use and reused after.
   *
   * One server per workspace: a session belongs to the directory its server runs
   * in, so a different workspace needs its own.
   */
  private async serverFor(cwd: string): Promise<OpenCodeServerHandle> {
    if (this.server !== undefined && this.serverCwd === cwd) {
      return this.server;
    }

    this.stop();
    const started = await this.startServer(cwd);
    this.server = started;
    this.serverCwd = cwd;

    return started;
  }

  private async *run(text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    let server: OpenCodeServerHandle;

    try {
      server = await this.serverFor(options.cwd);
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot start the opencode server.',
      };
      yield { type: 'done', exitCode: 1 };
      return;
    }

    const call = async (path: string, body?: unknown): Promise<Response> =>
      fetch(`${server.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: server.authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // Opened before anything is asked of the session, so no event can slip through
    // between the prompt being accepted and the stream being read.
    const streamAbort = new AbortController();
    let stream: Response;

    try {
      stream = await fetch(`${server.baseUrl}/event?directory=${encodeURIComponent(options.cwd)}`, {
        headers: { authorization: server.authorization, accept: 'text/event-stream' },
        signal: streamAbort.signal,
      });
    } catch (error) {
      yield {
        type: 'error',
        message: error instanceof Error ? error.message : 'Cannot read from the opencode server.',
      };
      yield { type: 'done', exitCode: 1 };
      return;
    }

    const body = stream.body;

    if (!stream.ok || body === null) {
      yield { type: 'error', message: `The opencode server refused the event stream.` };
      yield { type: 'done', exitCode: 1 };
      return;
    }

    try {
      const opened = await openSession(call, text, options);

      if (!opened.ok) {
        yield { type: 'error', message: opened.message };
        yield { type: 'done', exitCode: 1 };
        return;
      }

      const sessionId = opened.id;

      // Reported before any answer, so a run cut short still leaves an id to
      // continue from.
      yield { type: 'session', id: sessionId };

      // Aborting has to reach the engine, which is a separate process: dropping the
      // stream alone would leave it working on an answer nobody wants.
      const onAbort = (): void => {
        void call(`/session/${encodeURIComponent(sessionId)}/abort`, {});
        streamAbort.abort();
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        yield* this.consume(body, sessionId, options, call);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }
    } finally {
      streamAbort.abort();
    }
  }

  /** Maps the server's event stream onto engine events until the turn ends. */
  private async *consume(
    body: ReadableStream<Uint8Array>,
    sessionId: string,
    options: PromptOptions,
    call: (path: string, body?: unknown) => Promise<Response>,
  ): AsyncGenerator<EngineEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    /**
     * Sessions this turn owns: the one that was prompted, and the ones opencode
     * starts under it.
     *
     * A subagent runs in a child session of its own, so everything it does arrives
     * under a session id this turn has never seen. Ignoring those ids leaves the
     * turn blind to the work: its tool calls go unreported, and its permission asks
     * are dropped, which strands the subagent waiting for an answer nobody was
     * given the chance to make. See ADR-023.
     */
    const ownSessions = new Set([sessionId]);

    // Text is only the assistant's. The prompt comes back as a part of its own, and
    // emitting that would replay the user's own words as an answer.
    const assistantMessages = new Set<string>();
    const streamedParts = new Set<string>();
    const emittedText = new Map<string, string>();
    const reportedTools = new Set<string>();
    const reportedRefusals = new Set<string>();

    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        yield { type: 'done', exitCode: 0 };
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue;
        }

        let event: ServerEvent;
        try {
          event = JSON.parse(line.slice(6)) as ServerEvent;
        } catch {
          continue;
        }

        const properties = event.properties ?? {};

        // Read before the session filter, which is what decides whether the new
        // session belongs to this turn at all.
        if (event.type === 'session.created') {
          const info = properties.info;
          const created = typeof info?.id === 'string' ? info.id : '';
          const parent = typeof info?.parentID === 'string' ? info.parentID : '';

          if (created !== '' && ownSessions.has(parent)) {
            ownSessions.add(created);
          }
          continue;
        }

        const from = typeof properties.sessionID === 'string' ? properties.sessionID : undefined;

        // The server can host more than one session, so anything outside the ones
        // this turn owns is not its business.
        if (from !== undefined && !ownSessions.has(from)) {
          continue;
        }

        // Whether this came from the session that was prompted rather than from a
        // subagent under it. What ends the turn, and what counts as the answer, is
        // only ever the prompted session's.
        const prompted = from === undefined || from === sessionId;

        if (event.type === 'message.updated') {
          const info = properties.info;

          // Only the prompted session's assistant messages, because a subagent's
          // narration is not the answer to the prompt. Its tool calls are still
          // reported: leaving those out is what made a working turn look hung.
          if (prompted && info?.role === 'assistant' && typeof info.id === 'string') {
            assistantMessages.add(info.id);
          }
          continue;
        }

        if (event.type === 'message.part.delta') {
          if (
            properties.field !== 'text' ||
            typeof properties.delta !== 'string' ||
            properties.delta === '' ||
            typeof properties.messageID !== 'string' ||
            !assistantMessages.has(properties.messageID)
          ) {
            continue;
          }

          if (typeof properties.partID === 'string') {
            // Remembered so the finished part is not emitted again on top of the
            // fragments it was assembled from.
            streamedParts.add(properties.partID);
          }

          yield { type: 'delta', text: properties.delta };
          continue;
        }

        if (event.type === 'message.part.updated') {
          yield* mapPart(properties.part);
          continue;
        }

        if (event.type === 'permission.asked' || event.type === 'permission.updated') {
          const ask = readPermissionRequest(properties);

          if (ask === undefined) {
            continue;
          }

          // Refusal is the fallback for a caller that cannot answer or throws,
          // because the alternative is running a tool call nobody agreed to.
          let decision: EnginePermissionDecision = 'reject';

          if (options.requestPermission !== undefined) {
            try {
              decision = await options.requestPermission(ask);
            } catch {
              decision = 'reject';
            }
          }

          // Answered on the session that asked, which is a subagent's own session
          // when a subagent asked. The prompted session does not know the id.
          await call(
            `/session/${encodeURIComponent(from ?? sessionId)}/permissions/${encodeURIComponent(ask.id)}`,
            { response: decision },
          );
          continue;
        }

        if (prompted && event.type === 'session.error') {
          const error = properties.error;
          yield {
            type: 'error',
            message: typeof error === 'string' ? error : 'The engine reported an error.',
          };
          yield { type: 'done', exitCode: 1 };
          return;
        }

        // A subagent falling idle only means its own session finished, and the turn
        // it was started for is still working.
        if (prompted && event.type === 'session.idle') {
          yield { type: 'done', exitCode: 0 };
          return;
        }
      }
    }

    /** One tool part, which is repeated as the call progresses. */
    function* mapPart(part: EventPart | undefined): Generator<EngineEvent> {
      if (part === undefined) {
        return;
      }

      if (part.type === 'text') {
        const id = typeof part.id === 'string' ? part.id : '';
        const messageId = typeof part.messageID === 'string' ? part.messageID : '';

        // Already delivered fragment by fragment. Only a part that never streamed
        // is emitted from here, which is what a provider that answers in one piece
        // produces.
        if (
          id === '' ||
          streamedParts.has(id) ||
          !assistantMessages.has(messageId) ||
          typeof part.text !== 'string'
        ) {
          return;
        }

        const previous = emittedText.get(id) ?? '';
        emittedText.set(id, part.text);

        const fragment = part.text.startsWith(previous)
          ? part.text.slice(previous.length)
          : part.text;

        if (fragment !== '') {
          yield { type: 'delta', text: fragment };
        }
        return;
      }

      if (part.type !== 'tool' || typeof part.tool !== 'string' || part.tool === '') {
        return;
      }

      const id = typeof part.callID === 'string' ? part.callID : (part.id as string | undefined);

      if (id === undefined) {
        return;
      }

      const status = part.state?.status;

      // A call is announced with no arguments and filled in a moment later, so
      // reporting it at that first sighting would show a tool acting on nothing.
      if (status !== 'pending' && !reportedTools.has(id)) {
        reportedTools.add(id);
        const target = readActivityTarget(part.state?.input);

        yield {
          type: 'activity',
          id,
          tool: part.tool,
          ...(target !== undefined ? { target } : {}),
        };
      }

      const output = part.state?.output;

      if (status === 'completed' && typeof output === 'string' && output !== '') {
        yield { type: 'activity_output', id, output };
      }

      const error = part.state?.error;

      if (typeof error === 'string' && error !== '') {
        yield { type: 'activity_output', id, output: error };

        // Only when nobody could be asked. With asks on, a refusal is one the
        // caller decided and already knows the reason for. See ADR-022.
        if (
          options.requestPermission === undefined &&
          PERMISSION_PATTERN.test(error) &&
          !reportedRefusals.has(id)
        ) {
          reportedRefusals.add(id);
          yield { type: 'blocked', tool: part.tool, reason: shortenReason(error) };
        }
      }
    }
  }
}

type OpenedSession = { ok: true; id: string } | { ok: false; message: string };

/**
 * Sends the prompt, into the session being continued when there is one.
 *
 * A stale id is expected rather than exceptional: sessions live in opencode and
 * can be pruned at any time, so a refused resume starts a new session instead of
 * failing the turn. Answering without the earlier context is better than not
 * answering.
 */
async function openSession(
  call: (path: string, body?: unknown) => Promise<Response>,
  text: string,
  options: PromptOptions,
): Promise<OpenedSession> {
  const prompt = { parts: [{ type: 'text', text }], ...readModel(options.model) };

  if (options.resume !== undefined) {
    const resumed = await call(
      `/session/${encodeURIComponent(options.resume)}/prompt_async`,
      prompt,
    );

    if (resumed.ok) {
      return { ok: true, id: options.resume };
    }
  }

  const created = await call('/session', { title: SESSION_TITLE });

  if (!created.ok) {
    return { ok: false, message: 'The opencode server would not start a session.' };
  }

  const payload = (await created.json()) as { id?: unknown };
  const id = typeof payload.id === 'string' ? payload.id : '';

  if (id === '') {
    return { ok: false, message: 'The opencode server started a session with no id.' };
  }

  const sent = await call(`/session/${encodeURIComponent(id)}/prompt_async`, prompt);

  return sent.ok
    ? { ok: true, id }
    : { ok: false, message: 'The opencode server refused the prompt.' };
}

/** The model as opencode wants it, split from the provider/model form. */
function readModel(model: string | undefined): {
  model?: { providerID: string; modelID: string };
} {
  if (model === undefined) {
    return {};
  }

  const separator = model.indexOf('/');

  if (separator <= 0 || separator === model.length - 1) {
    return {};
  }

  return {
    model: { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) },
  };
}
