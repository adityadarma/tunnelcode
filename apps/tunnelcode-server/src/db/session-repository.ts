import { and, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, devices, sessions } from './schema.js';

export interface PersistSessionInput {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  engine: string;
}

export interface SessionDetail {
  id: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  /** Engine the session was paired with, the starting point for a new conversation. */
  engine: string;
}

/**
 * Persists devices and sessions.
 *
 * Realtime state stays in memory; this is only the durable record of what has
 * paired, so history survives a restart. See ADR-006.
 */
export class SessionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Records an approved pairing. Uses upsert on the device so a machine that
   * pairs repeatedly stays one row with a refreshed lastSeenAt.
   */
  persistApproved(input: PersistSessionInput): void {
    const now = Date.now();

    this.db
      .insert(devices)
      .values({
        id: input.deviceId,
        name: input.deviceName,
        createdAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: devices.id,
        set: { name: input.deviceName, lastSeenAt: now },
      })
      .run();

    this.db
      .insert(sessions)
      .values({
        id: input.sessionId,
        deviceId: input.deviceId,
        workspace: input.workspace,
        engine: input.engine,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  markEnded(sessionId: string): void {
    this.db.update(sessions).set({ endedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
  }

  findSession(sessionId: string): { id: string; deviceId: string } | undefined {
    const rows = this.db
      .select({ id: sessions.id, deviceId: sessions.deviceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .all();

    return rows[0];
  }

  /**
   * Session with the device it belongs to, which is what the browser needs to
   * show where a conversation runs.
   */
  findSessionDetail(sessionId: string): SessionDetail | undefined {
    const rows = this.db
      .select({
        id: sessions.id,
        deviceId: sessions.deviceId,
        deviceName: devices.name,
        workspace: sessions.workspace,
        engine: sessions.engine,
      })
      .from(sessions)
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .all();

    return rows[0];
  }

  /**
   * The session a conversation belongs to.
   *
   * Read when a conversation is changed on its own, without a session id in the
   * path: the device behind it is what decides whether an engine or a model is
   * allowed, and only the session knows which device that is.
   */
  findSessionForConversation(conversationId: string): SessionDetail | undefined {
    const rows = this.db
      .select({
        id: sessions.id,
        deviceId: sessions.deviceId,
        deviceName: devices.name,
        workspace: sessions.workspace,
        engine: sessions.engine,
      })
      .from(conversations)
      .innerJoin(sessions, eq(sessions.id, conversations.sessionId))
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(eq(conversations.id, conversationId))
      .limit(1)
      .all();

    return rows[0];
  }

  /**
   * Every session that is the same workspace on the same device.
   *
   * Pairing again creates a new session row, so without this the browser would
   * open on an empty list while the earlier conversations sit under the previous
   * id. Device and workspace together are what makes two sessions the same place:
   * the device id is derived from the machine and the workspace path, so it is
   * stable across restarts, and the workspace is compared as well rather than
   * trusted from the id alone.
   *
   * Ended sessions are included on purpose. Ending one only retires that pairing,
   * it does not mean the user threw away what was said in the workspace.
   */
  listSessionIdsForWorkspace(deviceId: string, workspace: string): string[] {
    return this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.deviceId, deviceId), eq(sessions.workspace, workspace)))
      .all()
      .map((row) => row.id);
  }

  /** Sessions belonging to a device, used to notify their browsers. */
  listSessionIdsByDevice(deviceId: string): string[] {
    return this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.deviceId, deviceId))
      .all()
      .map((row) => row.id);
  }

  countDevices(): number {
    return this.db.select({ id: devices.id }).from(devices).all().length;
  }
}
