import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A machine that has paired at least once.
 *
 * The pairing code is deliberately absent: a code is only valid while its CLI
 * session runs, so persisting it would outlive its meaning. See ADR-014.
 */
export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
});

/**
 * A session that was approved in the terminal. Stored so a browser refresh can
 * find its conversations again.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  deviceId: text('device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  workspace: text('workspace').notNull(),
  /**
   * Engine the session was paired with, which is what a conversation created in
   * it starts on.
   *
   * No longer the engine every prompt runs through: a conversation records its
   * own, and this is only the starting point. See ADR-020.
   */
  engine: text('engine').notNull(),
  createdAt: integer('created_at').notNull(),
  /**
   * When the conversation last moved: a prompt sent, or an answer stored.
   *
   * Persisted rather than kept in memory because this is what bounds how long a
   * session id is worth anything, and a server restart must not hand a stale id
   * another lifetime. Deliberately not touched by heartbeats or by a browser
   * attaching, or the timeout could never be reached. See ADR-026.
   *
   * Nullable, because a row written before this existed has no honest value to
   * put here; readers fall back to createdAt.
   */
  lastActivityAt: integer('last_activity_at'),
  endedAt: integer('ended_at'),
});

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    title: text('title'),
    /**
     * Engine every prompt in this conversation runs through.
     *
     * Chosen once, when the conversation is created, and never changed: the agent
     * accumulates context in an engine session, and moving a conversation to a
     * different engine would abandon it silently. Null on a conversation created
     * before this existed, which falls back to the engine of its session.
     * See ADR-020.
     */
    engine: text('engine'),
    /**
     * Model this conversation currently asks for, or null to let the engine
     * decide.
     *
     * Unlike the engine this can change: a model swap stays inside the same
     * engine, so the engine session and its context survive it.
     */
    model: text('model'),
    /**
     * The engine's own conversation id, so the next prompt continues where the
     * last one left off instead of starting an agent with no memory.
     *
     * Null until an engine reports one, which is also the state every
     * conversation created before this existed stays in. See ADR-005.
     */
    engineSessionId: text('engine_session_id'),
    /**
     * Engine that issued the id above. A session id only means something to the
     * engine that created it, so switching engines must not resume into it.
     */
    engineSessionEngine: text('engine_session_engine'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('conversations_session_idx').on(table.sessionId)],
);

/**
 * One finished message. Streaming deltas are never stored, only the assembled
 * result, which keeps writes proportional to messages instead of tokens.
 * See ADR-008.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    /**
     * True when the turn failed partway and this is only what the engine managed
     * to say. Kept so the transcript can mark it instead of presenting a truncated
     * reply as a finished answer.
     *
     * Defaults to false, which is what every row written before this existed is.
     */
    partial: integer('partial', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('messages_conversation_idx').on(table.conversationId)],
);

/**
 * A stretch of the model working itself out during a turn.
 *
 * Its own table for the same reason an activity has one: this is not conversation
 * text, and the role enum on messages has no room for it without retyping a
 * shipped column. Stored so the fold a reader opened is still there after a
 * refresh, and stored once per stretch rather than per fragment, which keeps
 * writes proportional to what the turn did. See ADR-005, ADR-008 and ADR-037.
 */
export const reasonings = sqliteTable(
  'reasonings',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('reasonings_conversation_idx').on(table.conversationId)],
);

/**
 * Something the engine did during a turn: a file it wrote, a command it ran.
 *
 * Kept in its own table rather than as another message role, because an activity
 * is not conversation text and the existing role enum has no room for it without
 * retyping a shipped column. See ADR-005.
 */
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Tool name as the engine reported it. */
    tool: text('tool').notNull(),
    /** What the tool acted on. Null when the engine did not say. */
    target: text('target'),
    /**
     * True when the engine was refused permission, so the call never happened.
     *
     * Stored alongside the calls that did happen, because a refusal is still part
     * of what the turn attempted. Defaults to false, which is what every row
     * written before this existed is.
     */
    blocked: integer('blocked', { mode: 'boolean' }).notNull().default(false),
    /** Why the call was refused. Null on a call that was allowed to run. */
    reason: text('reason'),
    /** Raw output of the tool execution, if the engine provided it. */
    output: text('output'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('activities_conversation_idx').on(table.conversationId)],
);
