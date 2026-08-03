import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { pushKeys, pushSubscriptions } from './schema.js';

/** The single row that holds this deployment's signing identity. */
const VAPID_ROW_ID = 'vapid';

/** A signing identity, base64url on both halves. */
export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

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
 * Persists push subscriptions and the key they were made against.
 *
 * Both have to survive a restart for a notification to arrive at all: a
 * subscription names a browser that is not connected, and it is only valid for the
 * public key it was created with. See ADR-045.
 */
export class PushRepository {
  constructor(private readonly db: Db) {}

  /** The stored signing identity, or undefined before one has been generated. */
  findKeys(): VapidKeyPair | undefined {
    const row = this.db
      .select({ publicKey: pushKeys.publicKey, privateKey: pushKeys.privateKey })
      .from(pushKeys)
      .where(eq(pushKeys.id, VAPID_ROW_ID))
      .get();

    return row === undefined ? undefined : { publicKey: row.publicKey, privateKey: row.privateKey };
  }

  /**
   * Writes the signing identity, keeping whichever one got there first.
   *
   * Nothing here runs concurrently today, but a pair that replaced an existing one
   * would silently retire every subscription already made against it, so the
   * insert refuses rather than overwrites and the caller reads back what is
   * stored.
   */
  saveKeys(keys: VapidKeyPair): void {
    this.db
      .insert(pushKeys)
      .values({
        id: VAPID_ROW_ID,
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Records where a browser can be reached.
   *
   * Keyed by endpoint, so a browser that subscribes again after pairing again moves
   * its row to the new session instead of leaving one behind that points at a
   * session nobody is watching.
   */
  save(input: SaveSubscriptionInput): void {
    this.db
      .insert(pushSubscriptions)
      .values({
        endpoint: input.endpoint,
        sessionId: input.sessionId,
        p256dh: input.p256dh,
        auth: input.auth,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { sessionId: input.sessionId, p256dh: input.p256dh, auth: input.auth },
      })
      .run();
  }

  listBySession(sessionId: string): StoredSubscription[] {
    return this.db
      .select({
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.sessionId, sessionId))
      .all();
  }

  /**
   * Forgets a subscription because the push service says it is gone.
   *
   * Not reachable from a request: a caller naming an endpoint is checked against the
   * session that owns it first. See removeForSession.
   */
  remove(endpoint: string): void {
    this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  }

  /**
   * Forgets everything filed against a session.
   *
   * A retired session cannot produce another ask or another answer, so an endpoint
   * kept for it is a row nothing will ever send to. The foreign key only covers a
   * session row that is deleted, and an ended one is marked rather than removed.
   */
  removeBySession(sessionId: string): void {
    this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.sessionId, sessionId)).run();
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
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.sessionId, sessionId)),
      )
      .run();
  }
}
