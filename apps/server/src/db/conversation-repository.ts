import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { activities, conversations, messages, reasonings } from './schema.js';

export type MessageRole = 'user' | 'assistant';

/**
 * Why an answer stopped short: the user asked, or something went wrong.
 *
 * Two cases rather than one, because telling a user their own stop was a failure is
 * a lie the transcript would keep repeating. See ADR-042.
 */
export type Interruption = 'stopped' | 'failed';

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** True when the turn ended partway and this is only what the engine said. */
  partial: boolean;
  /** Why it ended partway, when that was recorded. Null on a complete answer. */
  interruption: Interruption | null;
  createdAt: number;
}

/** Something the engine did during a turn, as stored for later. */
export interface StoredActivity {
  id: string;
  tool: string;
  target: string | null;
  /** True when the engine was refused permission, so the call never happened. */
  blocked: boolean;
  /** Why the call was refused. Null on a call that was allowed to run. */
  reason: string | null;
  /** The raw output of the tool execution. Null if not provided. */
  output: string | null;
  createdAt: number;
}

/** A stretch of the model working itself out, as stored for later. */
export interface StoredReasoning {
  id: string;
  content: string;
  createdAt: number;
}

/** Tokens spent, as the engines report them. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What a conversation has spent, and what its last reporting turn spent.
 *
 * Two figures because they answer different questions: the total is the cost, and
 * the last turn's input is roughly the context the conversation now carries. Every
 * field is null until something reports one, which is the state a conversation on
 * an engine that cannot count stays in forever.
 */
export interface StoredUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
}

export interface StoredConversation extends StoredUsage {
  id: string;
  title: string | null;
  /**
   * Engine every prompt here runs through. Null on a conversation created before
   * conversations had one, which falls back to the engine of its session.
   */
  engine: string | null;
  /** Model asked for, or null to let the engine decide. */
  model: string | null;
  /**
   * True while this conversation answers its own asks instead of asking anybody.
   *
   * False on every conversation that has never switched it on, including every one
   * created before this existed: nothing starts allowed. See ADR-059.
   */
  autopilot: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Engine conversation recorded for a conversation, if any.
 *
 * The engine name travels with the id because an id only means something to the
 * engine that issued it.
 */
export interface EngineSessionRef {
  id: string;
  engine: string;
}

/** Title is derived from the first prompt, trimmed to stay readable in a list. */
const TITLE_MAX_LENGTH = 60;

function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= TITLE_MAX_LENGTH ? flat : `${flat.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * Stores conversations and their finished messages.
 *
 * Streaming deltas never reach this class. A message is written once, after the
 * assistant has finished, which keeps writes proportional to messages rather
 * than tokens. See ADR-008.
 */
export class ConversationRepository {
  constructor(private readonly db: Db) {}

  /**
   * Creates a conversation on one engine.
   *
   * The engine is fixed here and never updated afterwards: the agent builds up
   * context inside an engine session, and moving the conversation elsewhere would
   * throw that away without saying so. The model is optional, meaning the engine
   * default. See ADR-020.
   */
  create(sessionId: string, engine: string, model?: string): StoredConversation {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      sessionId,
      title: null,
      engine,
      model: model ?? null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(conversations).values(row).run();

    return {
      id: row.id,
      title: row.title,
      engine: row.engine,
      model: row.model,
      inputTokens: null,
      outputTokens: null,
      lastInputTokens: null,
      lastOutputTokens: null,
      // A new conversation asks about everything. Autopilot is something the user
      // turns on for work they are watching start, never a state one arrives in.
      autopilot: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Turns autopilot on or off for one conversation.
   *
   * `updatedAt` is deliberately left alone, for the same reason usage leaves it
   * alone: flipping a switch is not something anybody said, and letting it reorder
   * the list would move a conversation nobody had spoken in.
   *
   * Returns false when there is no such conversation, which is what an id for
   * somebody else's row looks like from here.
   */
  setAutopilot(conversationId: string, enabled: boolean): boolean {
    const result = this.db
      .update(conversations)
      .set({ autopilot: enabled })
      .where(eq(conversations.id, conversationId))
      .run();

    return result.changes > 0;
  }

  /**
   * Whether a conversation answers its own asks.
   *
   * Read per ask rather than cached, so switching autopilot off takes effect on the
   * next ask instead of at the next restart. A conversation that no longer exists
   * reads as false: the safe reading of a missing row is that nothing is allowed.
   */
  isAutopilot(conversationId: string): boolean {
    const rows = this.db
      .select({ autopilot: conversations.autopilot })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .all();

    return rows[0]?.autopilot ?? false;
  }

  /**
   * Changes the model a conversation asks for.
   *
   * Allowed where changing the engine is not: a different model of the same engine
   * still understands the engine session, so the context carries over.
   */
  setModel(conversationId: string, model: string | undefined): boolean {
    const result = this.db
      .update(conversations)
      .set({ model: model ?? null, updatedAt: Date.now() })
      .where(eq(conversations.id, conversationId))
      .run();

    return result.changes > 0;
  }

  /**
   * Appends a finished message. The first user message also names the
   * conversation, so a list is readable without opening every entry.
   */
  appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    /**
     * Why this is not a whole answer. Absent stores a complete one.
     *
     * A reason rather than a flag, because the two ways an answer ends short read
     * differently to whoever comes back to it. The flag is still written, since it is
     * what every existing reader looks at.
     */
    interruption?: Interruption,
  ): StoredMessage {
    const now = Date.now();
    const message: StoredMessage = {
      id: randomUUID(),
      role,
      content,
      partial: interruption !== undefined,
      interruption: interruption ?? null,
      createdAt: now,
    };

    this.db
      .insert(messages)
      .values({
        id: message.id,
        conversationId,
        role,
        content,
        partial: message.partial,
        interruption: message.interruption,
        createdAt: now,
      })
      .run();

    const title = role === 'user' ? deriveTitle(content) : undefined;
    const existing = this.findById(conversationId);

    this.db
      .update(conversations)
      .set(
        title !== undefined && existing?.title === null
          ? { updatedAt: now, title }
          : { updatedAt: now },
      )
      .where(eq(conversations.id, conversationId))
      .run();

    return message;
  }

  /**
   * Records the engine conversation to continue next time.
   *
   * The engine name is stored alongside, because resuming an id into a different
   * engine would either fail or, worse, land in an unrelated conversation.
   */
  setEngineSession(conversationId: string, engineSessionId: string, engine: string): void {
    this.db
      .update(conversations)
      .set({ engineSessionId, engineSessionEngine: engine })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  /**
   * Engine conversation to continue, or undefined when there is none to continue
   * from.
   *
   * A row written before this feature existed has no id, which is why the absent
   * case is normal rather than an error.
   */
  findEngineSession(conversationId: string): EngineSessionRef | undefined {
    const rows = this.db
      .select({
        id: conversations.engineSessionId,
        engine: conversations.engineSessionEngine,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .all();

    const row = rows[0];

    if (row?.id === undefined || row.id === null || row.engine === null) {
      return undefined;
    }

    return { id: row.id, engine: row.engine };
  }

  /**
   * Records a finished stretch of thinking.
   *
   * Written when the model stops thinking rather than as the fragments arrive, for
   * the same reason a message is: the fold a reader opens is the whole thought, and
   * writing per fragment would put token-rate traffic into the database.
   * See ADR-008 and ADR-037.
   *
   * The conversation's updatedAt is deliberately left alone. Thinking is not
   * something the user said, and letting it reorder the conversation list would
   * move a conversation nobody had spoken in.
   */
  appendReasoning(conversationId: string, content: string): StoredReasoning {
    const reasoning: StoredReasoning = {
      id: randomUUID(),
      content,
      createdAt: Date.now(),
    };

    this.db
      .insert(reasonings)
      .values({
        id: reasoning.id,
        conversationId,
        content,
        createdAt: reasoning.createdAt,
      })
      .run();

    return reasoning;
  }

  /**
   * Records something the engine did. Unlike a message this is written as it
   * happens, because an activity is already complete when it is reported.
   */
  appendActivity(
    conversationId: string,
    id: string,
    tool: string,
    target: string | undefined,
    refusal?: { reason: string },
  ): StoredActivity {
    const now = Date.now();
    const activity: StoredActivity = {
      id,
      tool,
      target: target ?? null,
      blocked: refusal !== undefined,
      reason: refusal?.reason ?? null,
      output: null,
      createdAt: now,
    };

    this.db
      .insert(activities)
      .values({
        id: activity.id,
        conversationId,
        tool,
        target: activity.target,
        blocked: activity.blocked,
        reason: activity.reason,
        output: activity.output,
        createdAt: now,
      })
      .run();

    return activity;
  }

  /**
   * Appends a message with an explicit timestamp, for imported historical records.
   *
   * Like `appendMessage` but uses the provided `createdAt` instead of `Date.now()`,
   * and does NOT bump the conversation's `updatedAt` since these are backfilled
   * historical records rather than live activity. The title is still derived from
   * the first user message if the conversation does not yet have one.
   */
  appendMessageWithTimestamp(
    conversationId: string,
    role: MessageRole,
    content: string,
    createdAt: number,
  ): StoredMessage {
    const message: StoredMessage = {
      id: randomUUID(),
      role,
      content,
      partial: false,
      interruption: null,
      createdAt,
    };

    this.db
      .insert(messages)
      .values({
        id: message.id,
        conversationId,
        role,
        content,
        partial: false,
        interruption: null,
        createdAt,
      })
      .run();

    // Set title from first user message if conversation doesn't have one yet
    if (role === 'user') {
      const existing = this.findById(conversationId);
      if (existing?.title === null) {
        const title = deriveTitle(content);
        this.db
          .update(conversations)
          .set({ title })
          .where(eq(conversations.id, conversationId))
          .run();
      }
    }

    return message;
  }

  /**
   * Appends an activity with an explicit timestamp, for imported historical records.
   *
   * Like `appendActivity` but uses the provided `createdAt` instead of `Date.now()`,
   * and does NOT bump the conversation's `updatedAt` since these are backfilled
   * historical records rather than live activity.
   *
   * The row id is minted here rather than taken from the engine's tool-call id, the
   * way `appendMessageWithTimestamp` mints one. Reading the same agent session again
   * replays the same tool-call ids, and `activities.id` is a primary key across every
   * conversation, so trusting the engine's id made a second import of one session
   * collide with the first. An imported call is already finished and carries its
   * output inline, so nothing arriving later has to find it by the engine's id.
   */
  appendActivityWithTimestamp(
    conversationId: string,
    tool: string,
    target: string | undefined,
    output: string | null,
    createdAt: number,
  ): StoredActivity {
    const activity: StoredActivity = {
      id: randomUUID(),
      tool,
      target: target ?? null,
      blocked: false,
      reason: null,
      output,
      createdAt,
    };

    this.db
      .insert(activities)
      .values({
        id: activity.id,
        conversationId,
        tool,
        target: activity.target,
        blocked: false,
        reason: null,
        output: activity.output,
        createdAt,
      })
      .run();

    return activity;
  }

  /**
   * Updates an existing activity with its tool output.
   */
  updateActivityOutput(activityId: string, output: string): void {
    this.db.update(activities).set({ output }).where(eq(activities.id, activityId)).run();
  }

  /**
   * Adds a turn's tokens to the conversation and records them as the latest.
   *
   * The total accumulates and the latest is replaced, which is the whole difference
   * between the two figures. Existing nulls are read as zero for the sum only: a
   * conversation nobody had counted starts counting from this turn rather than
   * refusing to.
   *
   * Written once per turn, so the traffic stays proportional to turns rather than
   * to tokens. The conversation's updatedAt is deliberately left alone: spending
   * tokens is not something the user said, and letting it reorder the list would
   * move a conversation nobody had spoken in. See ADR-008.
   */
  addUsage(conversationId: string, spent: Usage): StoredUsage {
    const current = this.readUsage(conversationId);

    const updated: StoredUsage = {
      inputTokens: (current?.inputTokens ?? 0) + spent.inputTokens,
      outputTokens: (current?.outputTokens ?? 0) + spent.outputTokens,
      lastInputTokens: spent.inputTokens,
      lastOutputTokens: spent.outputTokens,
    };

    this.db.update(conversations).set(updated).where(eq(conversations.id, conversationId)).run();

    return updated;
  }

  /**
   * Records what the turn that is running has spent, without touching the total.
   *
   * Only the latest figures move, and they are replaced rather than added to, so this
   * can be written as often as the engine revises them: writing it twice leaves the
   * same row as writing it once. The total cannot be written this way, because adding
   * is not idempotent and a turn that reported five times would be charged five times.
   *
   * What it buys is a refresh mid-turn showing the turn that is running rather than
   * the one before it. `updatedAt` is left alone for the same reason `addUsage` leaves
   * it alone: spending tokens is not something the user said. See ADR-055.
   */
  setLastUsage(conversationId: string, spent: Usage): void {
    this.db
      .update(conversations)
      .set({ lastInputTokens: spent.inputTokens, lastOutputTokens: spent.outputTokens })
      .where(eq(conversations.id, conversationId))
      .run();
  }

  /** What a conversation has spent so far, or undefined when there is no such row. */
  readUsage(conversationId: string): StoredUsage | undefined {
    const rows = this.db
      .select({
        inputTokens: conversations.inputTokens,
        outputTokens: conversations.outputTokens,
        lastInputTokens: conversations.lastInputTokens,
        lastOutputTokens: conversations.lastOutputTokens,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .all();

    return rows[0];
  }

  findById(conversationId: string): StoredConversation | undefined {
    const rows = this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        engine: conversations.engine,
        model: conversations.model,
        inputTokens: conversations.inputTokens,
        outputTokens: conversations.outputTokens,
        lastInputTokens: conversations.lastInputTokens,
        lastOutputTokens: conversations.lastOutputTokens,
        autopilot: conversations.autopilot,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .all();

    return rows[0];
  }

  delete(conversationId: string): boolean {
    const result = this.db.delete(conversations).where(eq(conversations.id, conversationId)).run();
    return result.changes > 0;
  }

  listBySession(sessionId: string): StoredConversation[] {
    return this.listBySessions([sessionId]);
  }

  /**
   * Conversations belonging to any of several sessions.
   *
   * Pairing again creates a new session row for the same workspace, so a list
   * scoped to one id would look empty even though the history is right there. The
   * caller decides which ids count as the same place; this only reads them as one
   * list, ordered as though the session boundary were not there.
   */
  listBySessions(sessionIds: readonly string[]): StoredConversation[] {
    if (sessionIds.length === 0) {
      return [];
    }

    return this.db
      .select({
        id: conversations.id,
        title: conversations.title,
        engine: conversations.engine,
        model: conversations.model,
        inputTokens: conversations.inputTokens,
        outputTokens: conversations.outputTokens,
        lastInputTokens: conversations.lastInputTokens,
        lastOutputTokens: conversations.lastOutputTokens,
        autopilot: conversations.autopilot,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(inArray(conversations.sessionId, [...sessionIds]))
      .orderBy(asc(conversations.createdAt))
      .all();
  }

  /** Full history in order, which is what a browser refresh reloads. */
  listMessages(conversationId: string): StoredMessage[] {
    return this.db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        partial: messages.partial,
        interruption: messages.interruption,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
      .all();
  }

  /**
   * Thinking in order, returned as its own list for the same reason activities
   * are: the browser places each record by time, and the three shapes have nothing
   * else in common.
   */
  listReasonings(conversationId: string): StoredReasoning[] {
    return this.db
      .select({
        id: reasonings.id,
        content: reasonings.content,
        createdAt: reasonings.createdAt,
      })
      .from(reasonings)
      .where(eq(reasonings.conversationId, conversationId))
      .orderBy(asc(reasonings.createdAt))
      .all();
  }

  /**
   * Activities in order. Returned separately from messages so the browser can
   * place each one by time without the two lists having to share a shape.
   */
  listActivities(conversationId: string): StoredActivity[] {
    return this.db
      .select({
        id: activities.id,
        tool: activities.tool,
        target: activities.target,
        blocked: activities.blocked,
        reason: activities.reason,
        output: activities.output,
        createdAt: activities.createdAt,
      })
      .from(activities)
      .where(eq(activities.conversationId, conversationId))
      .orderBy(asc(activities.createdAt))
      .all();
  }
}
