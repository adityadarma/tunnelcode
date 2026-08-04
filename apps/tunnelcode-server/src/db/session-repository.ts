import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { conversations, devices, sessions } from './schema.js';

/**
 * How long a session survives without conversation activity.
 *
 * The same hour PROJECT.md names, enforced here as well as in the CLI: the CLI
 * timer only ends the process, and a session id outlives the process it was
 * created in. See ADR-026.
 */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * How long a session may live at all, however busy it is.
 *
 * The idle window slides: every prompt pushes it forward, so a session in use
 * never expires, and neither does one being used by somebody it does not belong
 * to. Whoever holds the credential only has to send something once an hour to keep
 * it alive forever, which is a lifetime that renews itself rather than a lifetime.
 * This is the ceiling the sliding window cannot move. See ADR-039.
 */
const SESSION_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

export interface PersistSessionInput {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  engine: string;
  /**
   * SHA-256 of the token the browser will present. The token itself never reaches
   * this layer. See ADR-041.
   */
  tokenHash: string;
  /**
   * SHA-256 of the id of the CLI run approving this. Null when the CLI is too old to
   * introduce itself, which reads as a run nobody can recognise. See ADR-043.
   */
  runIdHash: string | null;
  /** Version of the CLI that approved this session. Null when unknown. */
  cliVersion: string | null;
}

export interface SessionDetail {
  id: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  /** Engine the session was paired with, the starting point for a new conversation. */
  engine: string;
  /** CLI version at pairing time. Null when the CLI did not report one. */
  cliVersion: string | null;
}

/**
 * Persists devices and sessions.
 *
 * Realtime state stays in memory; this is only the durable record of what has
 * paired, so history survives a restart. See ADR-006.
 */
export class SessionRepository {
  private readonly idleMs: number;
  private readonly maxLifetimeMs: number;

  /**
   * Both windows are injectable so they can be tested without waiting out an hour
   * or half a day. Nothing in the app passes either.
   */
  constructor(
    private readonly db: Db,
    options: { idleMs?: number; maxLifetimeMs?: number } = {},
  ) {
    this.idleMs = options.idleMs ?? SESSION_IDLE_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? SESSION_MAX_LIFETIME_MS;
  }

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
        tokenHash: input.tokenHash,
        runIdHash: input.runIdHash,
        cliVersion: input.cliVersion,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  markEnded(sessionId: string): void {
    this.db.update(sessions).set({ endedAt: Date.now() }).where(eq(sessions.id, sessionId)).run();
  }

  /**
   * Records which CLI run a session now belongs to.
   *
   * Written when a session is approved again in the terminal, so the record names the
   * run that last agreed to it rather than the one that first did. Without this a
   * session that survived a CLI restart would be asked about again after every server
   * restart that followed. See ADR-043.
   */
  setRunIdHash(sessionId: string, runIdHash: string | null): void {
    this.db.update(sessions).set({ runIdHash }).where(eq(sessions.id, sessionId)).run();
  }

  /**
   * Live sessions of a device that the CLI run now connected already approved.
   *
   * Read when a CLI registers, so a server that restarted reinstates what this run
   * agreed to instead of interrupting the user about a machine that never went
   * anywhere. Ended, idle and expired sessions are left out by the shared predicate:
   * reinstating one would revive a session that is over. See ADR-043.
   */
  listSessionIdsForRun(deviceId: string, runIdHash: string): string[] {
    return this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.deviceId, deviceId), eq(sessions.runIdHash, runIdHash), this.live()))
      .all()
      .map((row) => row.id);
  }

  /**
   * Records conversation activity, which is what keeps a session alive.
   *
   * Called for a prompt and for an answer, never for a heartbeat or for a browser
   * attaching: those happen while nobody is using the agent, and counting them
   * would mean the timeout is never reached. See PROJECT.md (Pairing Code
   * Lifetime).
   */
  touch(sessionId: string): void {
    this.db
      .update(sessions)
      .set({ lastActivityAt: Date.now() })
      .where(eq(sessions.id, sessionId))
      .run();
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
   * What every read of a live session agrees on.
   *
   * A session the user ended is gone, not merely marked. Read without this, endedAt
   * was a record of an intention that bound nothing: the same id could be attached
   * again afterwards, and a browser holding it could still answer a permission ask
   * on the machine. Every caller wants an ended session to be absent, so it is
   * filtered here rather than at each of them.
   *
   * An idle session is gone for the same reason and in the same place. A session is
   * what lets a browser drive an agent on someone's machine, and one that nothing
   * has used for an hour has no business still doing that: the device id is derived
   * from the machine and the workspace, so a leaked credential would keep matching
   * every time the CLI is started there again.
   *
   * The age check is the one the idle window cannot slide. Activity moves the idle
   * deadline forward, including activity from whoever should not have the
   * credential, so without a ceiling a session that is being used is a session that
   * never expires. See ADR-039.
   *
   * The fallback to createdAt covers a row written before the activity column
   * existed, which would otherwise read as idle since 1970 and lock the user out of
   * their own history.
   */
  private live(): ReturnType<typeof and> {
    const now = Date.now();

    return and(
      isNull(sessions.endedAt),
      sql`coalesce(${sessions.lastActivityAt}, ${sessions.createdAt}) > ${now - this.idleMs}`,
      sql`${sessions.createdAt} > ${now - this.maxLifetimeMs}`,
    );
  }

  /**
   * Session with the device it belongs to, which is what the browser needs to
   * show where a conversation runs.
   *
   * Takes the id rather than the credential, because the id is what a path carries.
   * Holding it is not a claim on anything: the routes resolve the caller from its
   * cookie first and only then look a session up by id. See ADR-041.
   */
  findSessionDetail(sessionId: string): SessionDetail | undefined {
    const rows = this.db
      .select({
        id: sessions.id,
        deviceId: sessions.deviceId,
        deviceName: devices.name,
        workspace: sessions.workspace,
        engine: sessions.engine,
        cliVersion: sessions.cliVersion,
      })
      .from(sessions)
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(and(eq(sessions.id, sessionId), this.live()))
      .limit(1)
      .all();

    return rows[0];
  }

  /**
   * The session a token belongs to, or undefined when it belongs to none.
   *
   * The only way a browser is identified. A row with no hash cannot match, which is
   * how a session written before tokens existed ends up asking to pair again rather
   * than being trusted on its id alone.
   */
  findSessionByToken(tokenHash: string): SessionDetail | undefined {
    const rows = this.db
      .select({
        id: sessions.id,
        deviceId: sessions.deviceId,
        deviceName: devices.name,
        workspace: sessions.workspace,
        engine: sessions.engine,
        cliVersion: sessions.cliVersion,
      })
      .from(sessions)
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .where(and(eq(sessions.tokenHash, tokenHash), this.live()))
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
        cliVersion: sessions.cliVersion,
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
