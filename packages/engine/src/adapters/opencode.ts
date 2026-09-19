import { homedir } from 'node:os';
import { join } from 'node:path';

import { captureOutput, isOnPath, MODEL_LIST_TIMEOUT_MS } from '../which.js';
import { readActivityTarget } from '../activity.js';
import { openSqliteReadonly } from '../sqlite.js';
import { readResultBody } from './opencode-output.js';
import { startOpenCodeServer } from './opencode-server.js';
import type { OpenCodeServerHandle, StartOpenCodeServer } from './opencode-server.js';
import { labelledById } from '../types.js';
import type {
  EngineModel,
  Engine,
  EngineEvent,
  EnginePermissionDecision,
  EnginePermissionRequest,
  PromptOptions,
} from '../types.js';
import type {
  SessionActivity,
  SessionContent,
  SessionMessage,
  SessionSummary,
} from '../session.js';

const COMMAND = 'opencode';

/** A model id looks like provider/model, which is what opencode reports. */
const MODEL_PATTERN = /^[\w.-]+\/[\w./-]+$/;

/** One model record from `opencode models --verbose`. */
interface VerboseModel {
  id?: unknown;
  providerID?: unknown;
  name?: unknown;
}

/**
 * Reads the models out of `opencode models --verbose`.
 *
 * The output alternates an id line with the model's record, pretty-printed. A record
 * is recognised by its braces sitting at column zero, which is what tells the object
 * apart from the indented ones nested inside it — and, unlike counting braces, is not
 * confused by one inside a string.
 *
 * The id is composed from the record rather than read from the line above it, so a
 * record cannot be paired with the wrong id. `providerID/id` is exactly what the
 * plain listing prints, verified against it entry for entry, and it is what `--model`
 * takes back.
 *
 * A name is only qualified by its provider when another provider offers the same
 * name. Names like `Claude Opus 5` are shared the moment two routers are connected,
 * and two options reading alike would be a choice nobody could make; qualifying the
 * ones that do not need it would just be noise.
 */
function readVerboseModels(output: string): EngineModel[] {
  const records: VerboseModel[] = [];
  let buffer = '';

  for (const line of output.split('\n')) {
    if (buffer === '') {
      if (line !== '{') {
        continue;
      }

      buffer = `${line}\n`;
      continue;
    }

    buffer += `${line}\n`;

    if (line !== '}') {
      continue;
    }

    try {
      records.push(JSON.parse(buffer) as VerboseModel);
    } catch {
      // A record that will not parse is skipped rather than failing the listing: the
      // ones around it are still worth offering.
    }

    buffer = '';
  }

  const models: { id: string; name: string; provider: string }[] = [];

  for (const record of records) {
    const id = record.id;
    const provider = record.providerID;

    if (typeof id !== 'string' || id === '' || typeof provider !== 'string' || provider === '') {
      continue;
    }

    const composed = `${provider}/${id}`;

    if (!MODEL_PATTERN.test(composed) || models.some((model) => model.id === composed)) {
      continue;
    }

    const name = record.name;
    models.push({
      id: composed,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : composed,
      provider,
    });
  }

  const shared = new Set(
    models.map((model) => model.name).filter((name, index, all) => all.indexOf(name) !== index),
  );

  return models.map((model) => ({
    id: model.id,
    label: shared.has(model.name) ? `${model.name} (${model.provider})` : model.name,
  }));
}

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

/**
 * What an assistant message has cost, as opencode reports it.
 *
 * Cache is a pair of its own rather than folded into the input, and thinking is
 * counted apart from the answer, which is why reading only `input` and `output`
 * would report a fraction of the turn.
 */
interface EventTokens {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown };
}

interface EventProperties {
  sessionID?: unknown;
  messageID?: unknown;
  partID?: unknown;
  field?: unknown;
  delta?: unknown;
  part?: EventPart;
  info?: { id?: unknown; role?: unknown; parentID?: unknown; tokens?: EventTokens };
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

/** One reported count, or zero for anything that is not a count. */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * What one assistant message cost, as two figures.
 *
 * Cache reads and writes are counted as input because that is what was sent to
 * the provider and charged for: opencode's own `total` includes them, and a figure
 * that left them out would report 6,742 for a turn that spent 8,598. Thinking is
 * counted as output for the same reason — the model produced it. Added up, the two
 * come to the total opencode reports beside them.
 */
export function readSpend(tokens: EventTokens | undefined): {
  input: number;
  output: number;
} {
  if (tokens === undefined) {
    return { input: 0, output: 0 };
  }

  return {
    input: readCount(tokens.input) + readCount(tokens.cache?.read) + readCount(tokens.cache?.write),
    output: readCount(tokens.output) + readCount(tokens.reasoning),
  };
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
  readonly label = 'OpenCode';
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

  /**
   * Reads the model list from `opencode models --verbose`.
   *
   * The verbose form is asked for because the plain one prints ids alone, and
   * opencode does know a name for every model: its own picker shows `Claude Opus 5`
   * where the id reads `9Router/claude-opus-5`. Verbose prints each id followed by
   * the model's record, which carries that name. Recorded from opencode's own
   * output. See ADR-051.
   *
   * The plain listing is the fallback, for a version whose `--verbose` is missing or
   * prints something this cannot read. Then a model is labelled by its id, which is
   * what it was before names were read at all.
   */
  async listModels(): Promise<EngineModel[]> {
    const verbose = await captureOutput(COMMAND, ['models', '--verbose'], {
      timeoutMs: MODEL_LIST_TIMEOUT_MS,
    });
    const named = verbose === undefined ? [] : readVerboseModels(verbose);

    if (named.length > 0) {
      return named;
    }

    const output =
      verbose ?? (await captureOutput(COMMAND, ['models'], { timeoutMs: MODEL_LIST_TIMEOUT_MS }));

    if (output === undefined) {
      return [];
    }

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => MODEL_PATTERN.test(line))
      .map(labelledById);
  }

  /**
   * Lists local opencode sessions started in the given working directory.
   *
   * opencode keeps its history in one SQLite database shared by every workspace,
   * which is why the directory is a column to filter on rather than a folder to
   * look in. The filtering, the ordering and the cap all happen in SQL: the
   * database is hundreds of megabytes of tool output on a machine that has used
   * opencode for a while, and reading it into this process to sort it afterwards
   * would cost the whole file to answer a question about fifty rows.
   *
   * Returns an empty array when there is no database, which is what an install
   * that has never run a session looks like. A database that exists and cannot
   * be read raises instead, so the caller can say why rather than reporting the
   * history as empty.
   */
  async listLocalSessions(cwd: string): Promise<SessionSummary[]> {
    const database = await openSqliteReadonly(openCodeDatabasePath());

    if (database === undefined) {
      return [];
    }

    try {
      const rows = database.all<SessionRow>(
        `select id, title, time_created as timeCreated, time_updated as timeUpdated
           from session
          where directory = ?
          order by time_updated desc
          limit ?`,
        cwd,
        SESSION_LIMIT,
      );

      // Read into a shape of this adapter's own before anything else is asked of
      // the database, so a row it cannot make sense of is dropped rather than
      // carried through the queries that follow it.
      const listed: { id: string; title: string; lastActiveAt: string }[] = [];

      for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : '';
        // Falls back to when the session started, because a row whose update time
        // cannot be read is still a session worth offering. Dropped only when
        // neither timestamp makes sense, since then nothing dates it.
        const lastActiveAt = readTimestamp(row.timeUpdated) ?? readTimestamp(row.timeCreated);

        if (id === '' || lastActiveAt === undefined) {
          continue;
        }

        const title = typeof row.title === 'string' ? row.title.trim() : '';
        listed.push({ id, title, lastActiveAt });
      }

      if (listed.length === 0) {
        return [];
      }

      const ids = listed.map((session) => session.id);
      const list = ids.map(() => '?').join(', ');

      // Both counted in one grouped query rather than one query per session: the
      // message table holds every message of every workspace, so fifty round
      // trips would each scan the same index for a figure one pass already has.
      const counts = new Map<string, number>();
      for (const row of database.all<CountRow>(
        `select session_id as sessionId, count(*) as count
           from message
          where session_id in (${list})
            and json_extract(data, '$.role') in ('user', 'assistant')
          group by session_id`,
        ...ids,
      )) {
        counts.set(row.sessionId, typeof row.count === 'number' ? row.count : 0);
      }

      // The last thing the assistant said, cut in SQL. A single answer can run to
      // tens of kilobytes and only the opening line is ever shown.
      const previews = new Map<string, string>();
      for (const row of database.all<TextRow>(
        `select sessionId, substr(text, 1, ?) as text
           from (${textPerSession('assistant', 'desc', list)})
          where ordinal = 1`,
        PREVIEW_MAX_LENGTH,
        ...ids,
      )) {
        previews.set(row.sessionId, typeof row.text === 'string' ? row.text : '');
      }

      // opencode titles a session itself, so the first user message is only read
      // for the sessions whose title is still empty. Asked for unconditionally it
      // would be the most expensive query here, in aid of nothing.
      const untitled = listed.filter((session) => session.title === '').map((s) => s.id);
      const openings = new Map<string, string>();

      if (untitled.length > 0) {
        for (const row of database.all<TextRow>(
          `select sessionId, substr(text, 1, ?) as text
             from (${textPerSession('user', 'asc', untitled.map(() => '?').join(', '))})
            where ordinal = 1`,
          TITLE_MAX_LENGTH,
          ...untitled,
        )) {
          openings.set(row.sessionId, typeof row.text === 'string' ? row.text : '');
        }
      }

      return listed.map((session) => {
        const opening = openings.get(session.id)?.trim() ?? '';

        return {
          id: session.id,
          title:
            session.title !== '' ? session.title : opening !== '' ? opening : 'Untitled session',
          lastActiveAt: session.lastActiveAt,
          messageCount: counts.get(session.id) ?? 0,
          preview: previews.get(session.id) ?? '',
        };
      });
    } finally {
      database.close();
    }
  }

  /**
   * Reads the full content of a local opencode session for import.
   *
   * A message's role lives in its own JSON, and its text lives in the `text`
   * parts hanging off it, so the transcript is one join read in the order the
   * conversation happened. Tool calls are parts of the same list, which is why
   * they come out of the same pass as the messages.
   *
   * Throws when no session with that id was started in this directory. That is a
   * stale id rather than a machine that cannot be read, so it is a plain error.
   */
  async readSessionContent(sessionId: string, cwd: string): Promise<SessionContent> {
    const database = await openSqliteReadonly(openCodeDatabasePath());

    if (database === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      const found = database.all<{ id: string }>(
        'select id from session where id = ? and directory = ? limit 1',
        sessionId,
        cwd,
      );

      if (found.length === 0) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      // The messages are capped, and the parts follow from the messages, so a
      // session that somehow holds a hundred thousand of them cannot pull the
      // whole database through this process. The cap is far above any real
      // conversation: the longest recorded here runs to a few hundred.
      const rows = database.all<TranscriptRow>(
        `select m.id as messageId,
                json_extract(m.data, '$.role') as role,
                p.id as partId,
                p.data as part
           from message m
           join part p on p.message_id = m.id
          where m.session_id = ?
            and m.id in (
              select id from message where session_id = ? order by time_created, id limit ?
            )
          order by m.time_created, m.id, p.time_created, p.id`,
        sessionId,
        sessionId,
        TRANSCRIPT_MESSAGE_LIMIT,
      );

      const messages: SessionMessage[] = [];
      const activities: SessionActivity[] = [];

      let openMessage = '';
      let role: SessionMessage['role'] | undefined;
      let spoken: string[] = [];

      const close = (): void => {
        if (role !== undefined && spoken.length > 0) {
          messages.push({ role, content: spoken.join('\n') });
        }
      };

      for (const row of rows) {
        if (row.messageId !== openMessage) {
          close();
          openMessage = typeof row.messageId === 'string' ? row.messageId : '';
          role = readRole(row.role);
          spoken = [];
        }

        let part: StoredPart;
        try {
          part = JSON.parse(typeof row.part === 'string' ? row.part : '') as StoredPart;
        } catch {
          // One unreadable part is not worth losing the conversation around it.
          continue;
        }

        if (part.type === 'text') {
          if (role !== undefined && typeof part.text === 'string' && part.text !== '') {
            spoken.push(part.text);
          }
          continue;
        }

        if (part.type === 'tool') {
          const activity = readStoredActivity(row.partId, part);

          if (activity !== undefined) {
            activities.push(activity);
          }
        }

        // Everything else is bookkeeping rather than content. Recorded sessions
        // carry `step-start`, `step-finish`, `patch` and `snapshot` parts, and
        // `reasoning` holds what the model was working out rather than what it
        // said. Nothing is matched by name here: only text and tool calls are read
        // out, so a part type opencode adds later is ignored rather than relayed
        // into the transcript as though the assistant had said it.
      }

      close();

      return { engineSessionId: sessionId, messages, activities };
    } finally {
      database.close();
    }
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

    /**
     * Parts carrying the model's thinking rather than its answer.
     *
     * Tracked because a reasoning part streams through the same
     * `message.part.delta` event as an answer does, with the same `field: 'text'`:
     * both parts name their own text field `text`, so the field cannot tell them
     * apart and the part id is the only thing that can. Without this the thinking
     * is relayed as assistant text and the reader sees the model deliberating
     * about them, run together with the answer that follows it.
     *
     * A part is announced by `message.part.updated` before any of its fragments
     * arrive, which is what makes recognising it by id possible at all.
     */
    const reasoningParts = new Set<string>();
    const streamedParts = new Set<string>();
    const emittedText = new Map<string, string>();
    const reportedTools = new Set<string>();
    const reportedRefusals = new Set<string>();

    /**
     * What each assistant message of this turn has cost, by message id.
     *
     * Replaced per message rather than added to, because `message.updated` repeats
     * the running figures for the same message: added, a turn that reported twice
     * would be charged twice. Summed across messages, because a turn that stopped to
     * run a tool answers in more than one, and a subagent answers in a session of
     * its own that this turn still paid for. See ADR-023.
     */
    const spend = new Map<string, { input: number; output: number }>();

    /** The last figures reported, so an update that changed nothing says nothing. */
    let reported: { input: number; output: number } | undefined;

    /**
     * The turn's spend so far, reported as opencode revises it and again as the turn
     * ends.
     *
     * It used to be held back until the end, so that what reached the browser was
     * what the turn cost rather than a figure climbing while it was read. That is the
     * wrong way round for a turn that takes minutes: a cost nobody can see until it
     * is settled is a cost nobody can act on. The last one of a turn still says what
     * the turn cost, because every one of these carries the whole running total and a
     * reader replaces rather than adds. See ADR-055.
     *
     * Nothing is emitted when opencode reported no counts at all, which the rest of
     * the system reads as unknown rather than as zero, and nothing is emitted twice
     * for figures that have not moved.
     */
    const usage = (): EngineEvent[] => {
      let inputTokens = 0;
      let outputTokens = 0;

      for (const message of spend.values()) {
        inputTokens += message.input;
        outputTokens += message.output;
      }

      if (inputTokens === 0 && outputTokens === 0) {
        return [];
      }

      if (reported?.input === inputTokens && reported.output === outputTokens) {
        return [];
      }

      reported = { input: inputTokens, output: outputTokens };

      return [{ type: 'usage', inputTokens, outputTokens }];
    };

    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        yield* usage();
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

          // Counted for every session this turn owns, not just the prompted one: a
          // subagent's tokens were spent answering this prompt, and a total that
          // left them out would read as cheaper than the turn was.
          if (info?.role === 'assistant' && typeof info.id === 'string') {
            spend.set(info.id, readSpend(info.tokens));

            // Said as soon as opencode revises the figures, so a long turn reports
            // what it is costing rather than only what it cost. See ADR-055.
            yield* usage();
          }

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

          // Thinking, not the answer. Reported as its own event so the reader is
          // never shown the model working itself out as though it were speaking to
          // them, and can still open it when they want to see the working.
          // See ADR-037.
          if (typeof properties.partID === 'string' && reasoningParts.has(properties.partID)) {
            yield { type: 'reasoning', text: properties.delta };
            continue;
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
          // Reported for a failed turn too. The tokens were spent whether or not an
          // answer came of them, and a turn that cost something and says it cost
          // nothing is the one reading nobody can act on.
          yield* usage();
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
          yield* usage();
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

      // Recorded before any fragment of it arrives, which is the only reason the
      // deltas that follow can be recognised as thinking.
      if (part.type === 'reasoning') {
        const id = typeof part.id === 'string' ? part.id : '';

        if (id === '') {
          return;
        }

        reasoningParts.add(id);

        // Emitted from here only when the part never streamed, which is the same
        // fallback a text part has: a provider that answers in one piece reports
        // the whole thought on the part instead of in fragments.
        if (streamedParts.has(id) || typeof part.text !== 'string') {
          return;
        }

        const seen = emittedText.get(id) ?? '';
        emittedText.set(id, part.text);

        const thought = part.text.startsWith(seen) ? part.text.slice(seen.length) : part.text;

        if (thought !== '') {
          yield { type: 'reasoning', text: thought };
        }
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
        // The read tool answers in an envelope naming the file it just read, which
        // is already the target shown above the output. Unwrapped here rather than
        // in the browser, because the shape belongs to this engine.
        const readable = part.tool === 'read' ? readResultBody(output) : output;

        if (readable !== '') {
          yield { type: 'activity_output', id, output: readable };
        }
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

// ---------------------------------------------------------------------------
// OpenCode session helpers
// ---------------------------------------------------------------------------

/** How many sessions a listing offers, newest first. */
const SESSION_LIMIT = 50;

/** How much of an answer a preview shows. */
const PREVIEW_MAX_LENGTH = 200;

/** How much of a first message stands in for a missing title. */
const TITLE_MAX_LENGTH = 100;

/**
 * How many messages one import reads.
 *
 * Far above any conversation recorded here, where the longest runs to a few
 * hundred. It is a bound on the pathological case rather than a product
 * decision: the parts of a message hold whole tool outputs, so a session with a
 * runaway loop in it could otherwise pull a large share of a database that
 * reaches hundreds of megabytes into this process.
 */
const TRANSCRIPT_MESSAGE_LIMIT = 2000;

/** One row of the session listing, as this adapter's SQL selects it. */
interface SessionRow {
  id: unknown;
  title: unknown;
  timeCreated: unknown;
  timeUpdated: unknown;
}

interface CountRow {
  sessionId: string;
  count: unknown;
}

interface TextRow {
  sessionId: string;
  text: unknown;
}

interface TranscriptRow {
  messageId: unknown;
  role: unknown;
  partId: unknown;
  part: unknown;
}

/** A part as opencode stored it, which is the shape its events carry too. */
interface StoredPart {
  type?: unknown;
  text?: unknown;
  tool?: unknown;
  callID?: unknown;
  state?: ToolState;
}

/**
 * Where opencode keeps the database holding every session.
 *
 * One file for the whole machine, under the XDG data directory, which opencode
 * honours when it is set and otherwise defaults the same way this does.
 */
function openCodeDatabasePath(): string {
  const data = process.env['XDG_DATA_HOME'];
  const root = data !== undefined && data.trim() !== '' ? data : join(homedir(), '.local', 'share');

  return join(root, 'opencode', 'opencode.db');
}

/**
 * The text parts of one role, numbered within each session so the outer query
 * can take the first or the last of them.
 *
 * Written as a subquery rather than a join per session: the message and part
 * tables hold every workspace's history, and asking once per listed session
 * would walk the same indexes fifty times over. `direction` picks which end is
 * wanted, since a preview is the latest thing said and a title stand-in is the
 * earliest.
 */
function textPerSession(
  role: 'user' | 'assistant',
  direction: 'asc' | 'desc',
  list: string,
): string {
  const order = direction === 'desc' ? 'desc' : 'asc';

  return `select p.session_id as sessionId,
                 json_extract(p.data, '$.text') as text,
                 row_number() over (
                   partition by p.session_id
                   order by m.time_created ${order}, m.id ${order},
                            p.time_created ${order}, p.id ${order}
                 ) as ordinal
            from part p
            join message m on m.id = p.message_id
           where p.session_id in (${list})
             and json_extract(p.data, '$.type') = 'text'
             and json_extract(m.data, '$.role') = '${role}'
             and json_extract(p.data, '$.text') <> ''`;
}

/** Only the two roles a transcript is made of. Anything else is not a message. */
function readRole(value: unknown): SessionMessage['role'] | undefined {
  return value === 'user' || value === 'assistant' ? value : undefined;
}

/**
 * Reads a stored tool part as an activity.
 *
 * The call id is preferred over the part id because it is what the engine's own
 * events use, so an imported call and a live one are named the same way. A
 * refusal or a failure is carried as the output: what a tool call came to is more
 * use to a reader than a blank.
 */
function readStoredActivity(partId: unknown, part: StoredPart): SessionActivity | undefined {
  if (typeof part.tool !== 'string' || part.tool === '') {
    return undefined;
  }

  const id =
    typeof part.callID === 'string' && part.callID !== ''
      ? part.callID
      : typeof partId === 'string' && partId !== ''
        ? partId
        : undefined;

  if (id === undefined) {
    return undefined;
  }

  const state = part.state ?? {};
  const output = typeof state.output === 'string' && state.output !== '' ? state.output : '';
  const error = typeof state.error === 'string' && state.error !== '' ? state.error : '';

  // The read tool answers in an envelope naming the file it just read, which the
  // target already says. Unwrapped here for the same reason a live turn unwraps
  // it: the shape belongs to this engine.
  const body = output !== '' && part.tool === 'read' ? readResultBody(output) : output;

  return {
    id,
    tool: part.tool,
    target: readActivityTarget(state.input) ?? null,
    output: body !== '' ? body : error !== '' ? error : null,
  };
}

/**
 * Where a plain integer stops looking like milliseconds and starts looking like
 * seconds. Around 1973 in milliseconds and the year 5138 in seconds, so no real
 * timestamp is anywhere near it.
 */
const EPOCH_SECONDS_CEILING = 1e11;

/**
 * Reads one of opencode's timestamps as an ISO 8601 string.
 *
 * Stored as epoch milliseconds in the databases read here: the session recorded
 * on this machine carries `1786264956645`. The column is only declared `integer`
 * though, and SQLite lets a text date sit in one, so a seconds figure and the
 * `YYYY-MM-DD HH:MM:SS` form SQLite's own date helpers produce are both read
 * rather than assumed away.
 *
 * Returns undefined for anything that is not a date, which the caller treats as
 * a row it cannot place in time.
 */
function readTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return fromEpoch(Number(value));
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric) && numeric !== 0) {
    return fromEpoch(numeric);
  }

  // SQLite writes a date with a space where ISO has a T and no zone at all, and
  // it means UTC by it. Left unmarked, Date would read it as local time and the
  // listing would be hours out.
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(text);

  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** An epoch figure as an ISO string, in whichever unit it was written. */
function fromEpoch(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const milliseconds = value < EPOCH_SECONDS_CEILING ? value * 1000 : value;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
