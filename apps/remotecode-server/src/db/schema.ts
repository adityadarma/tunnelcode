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
  engine: text('engine').notNull(),
  createdAt: integer('created_at').notNull(),
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
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('activities_conversation_idx').on(table.conversationId)],
);
