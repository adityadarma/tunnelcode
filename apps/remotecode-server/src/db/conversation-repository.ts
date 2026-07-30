import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client.js';
import { activities, conversations, messages } from './schema.js';

export type MessageRole = 'user' | 'assistant';

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  /** True when the turn failed partway and this is only what the engine said. */
  partial: boolean;
  createdAt: number;
}

/** Something the engine did during a turn, as stored for later. */
export interface StoredActivity {
  id: string;
  tool: string;
  target: string | null;
  createdAt: number;
}

export interface StoredConversation {
  id: string;
  title: string | null;
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

  create(sessionId: string): StoredConversation {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      sessionId,
      title: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(conversations).values(row).run();
    return { id: row.id, title: row.title, createdAt: now, updatedAt: now };
  }

  /**
   * Appends a finished message. The first user message also names the
   * conversation, so a list is readable without opening every entry.
   */
  appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    partial = false,
  ): StoredMessage {
    const now = Date.now();
    const message: StoredMessage = {
      id: randomUUID(),
      role,
      content,
      partial,
      createdAt: now,
    };

    this.db
      .insert(messages)
      .values({
        id: message.id,
        conversationId,
        role,
        content,
        partial,
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
   * Records something the engine did. Unlike a message this is written as it
   * happens, because an activity is already complete when it is reported.
   */
  appendActivity(conversationId: string, tool: string, target: string | undefined): StoredActivity {
    const now = Date.now();
    const activity: StoredActivity = {
      id: randomUUID(),
      tool,
      target: target ?? null,
      createdAt: now,
    };

    this.db
      .insert(activities)
      .values({
        id: activity.id,
        conversationId,
        tool,
        target: activity.target,
        createdAt: now,
      })
      .run();

    return activity;
  }

  findById(conversationId: string): StoredConversation | undefined {
    const rows = this.db
      .select({
        id: conversations.id,
        title: conversations.title,
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
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt))
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
        createdAt: activities.createdAt,
      })
      .from(activities)
      .where(eq(activities.conversationId, conversationId))
      .orderBy(asc(activities.createdAt))
      .all();
  }
}
