import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { subscriptions } from './schema.js';

/** Where a browser can be reached, and what to encrypt for it. */
export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SaveSubscriptionInput extends StoredSubscription {
  sessionId: string;
}

/**
 * Persists push subscriptions.
 *
 * Subscriptions have to survive a restart for a notification to arrive at all: a
 * subscription names a browser that is not connected, and it is only valid for the
 * public key it was created with. The signing keys themselves are read from
 * environment variables. See ADR-045.
 */
export class PushRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records where a browser can be reached.
   *
   * Keyed by endpoint, so a browser that subscribes again after pairing again moves
   * its row to the new session instead of leaving one behind that points at a
   * session nobody is watching.
   */
  save(input: SaveSubscriptionInput): void {
    this.db
      .insert(subscriptions)
      .values({
        endpoint: input.endpoint,
        sessionId: input.sessionId,
        p256dh: input.p256dh,
        auth: input.auth,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: subscriptions.endpoint,
        set: { sessionId: input.sessionId, p256dh: input.p256dh, auth: input.auth },
      })
      .run();
  }

  listBySession(sessionId: string): StoredSubscription[] {
    return this.db
      .select({
        endpoint: subscriptions.endpoint,
        p256dh: subscriptions.p256dh,
        auth: subscriptions.auth,
      })
      .from(subscriptions)
      .where(eq(subscriptions.sessionId, sessionId))
      .all();
  }

  /**
   * Forgets a subscription because the push service says it is gone.
   *
   * Not reachable from a request: a caller naming an endpoint is checked against the
   * session that owns it first. See removeForSession.
   */
  remove(endpoint: string): void {
    this.db.delete(subscriptions).where(eq(subscriptions.endpoint, endpoint)).run();
  }

  /**
   * Forgets everything filed against a session.
   *
   * A retired session cannot produce another ask or another answer, so an endpoint
   * kept for it is a row nothing will ever send to. The foreign key only covers a
   * session row that is deleted, and an ended one is marked rather than removed.
   */
  removeBySession(sessionId: string): void {
    this.db.delete(subscriptions).where(eq(subscriptions.sessionId, sessionId)).run();
  }

  /**
   * Forgets a subscription a session owns.
   *
   * Scoped to the session rather than trusting the endpoint alone, because the
   * endpoint travels in a request body: without this, any paired browser could turn
   * off the notifications of any other by naming its endpoint.
   */
  removeForSession(endpoint: string, sessionId: string): void {
    this.db
      .delete(subscriptions)
      .where(and(eq(subscriptions.endpoint, endpoint), eq(subscriptions.sessionId, sessionId)))
      .run();
  }
}
