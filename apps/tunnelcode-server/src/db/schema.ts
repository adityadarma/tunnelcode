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
  /**
   * SHA-256 of the token the browser proves this session with.
   *
   * The token itself is never stored: it exists in the cookie and, for as long as
   * the pairing request is being polled, in memory. Hashing it means a copy of the
   * database is history rather than a set of working credentials. See ADR-041.
   *
   * Nullable, because a row written before this existed has none. Such a row
   * cannot be authenticated at all, which is the safe reading: the browser that
   * holds it has nothing to present, so it pairs again.
   */
  tokenHash: text('token_hash'),
  /**
   * SHA-256 of the id of the CLI run that approved this session.
   *
   * What lets consent outlive the server without outliving the run that gave it: a
   * server that restarted reinstates the sessions whose run is the one now connected,
   * and asks the terminal about the rest. Updated when a session is approved again,
   * so the record always names the run that last agreed to it.
   *
   * Null on a row from before this existed, and on one approved by a CLI too old to
   * introduce itself, both of which read as a run nobody can recognise. See ADR-043.
   */
  runIdHash: text('run_id_hash'),
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
    /**
     * Why the answer was cut short: `stopped` when the user asked for it, `failed`
     * for everything else.
     *
     * Alongside the flag rather than replacing it, because the flag has shipped and
     * a column is never retyped. Null on a complete answer, and on a partial one
     * written before this existed, which reads as a cause nobody recorded rather
     * than as a failure. See ADR-042.
     */
    interruption: text('interruption', { enum: ['stopped', 'failed'] }),
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

/**
 * The identity this server signs push messages with.
 *
 * One row, generated the first time a browser asks for the key. Persisted because
 * a subscription is made against a particular public key: a pair regenerated on
 * restart would leave every phone holding a subscription the push service refuses
 * to deliver on. See ADR-045.
 *
 * The private key is a signing identity for this deployment, not a user secret. It
 * proves to a push service which server is sending, and it cannot decrypt anything:
 * the payload is encrypted for the subscriber's own key, which this server never
 * holds either half of.
 */
export const pushKeys = sqliteTable('push_keys', {
  id: text('id').primaryKey(),
  /** Uncompressed P-256 point, base64url, as the browser is given it. */
  publicKey: text('public_key').notNull(),
  /** The scalar, base64url. */
  privateKey: text('private_key').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Where to reach a browser that is not currently connected.
 *
 * Keyed by endpoint rather than by an id of its own, because the endpoint is what
 * a push service considers the subscription: a browser that subscribes again for a
 * new session replaces its row instead of accumulating one per pairing.
 *
 * Tied to the session, and dropped with it, so notifications about an agent stop
 * when permission to reach that agent does. See ADR-045.
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The subscriber's public P-256 point, base64url. */
    p256dh: text('p256dh').notNull(),
    /** The shared authentication secret, base64url. */
    auth: text('auth').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('push_subscriptions_session_idx').on(table.sessionId)],
);
