/**
 * How long a person has to answer an ask before it is refused.
 *
 * Long enough to notice a notification and pick up the phone, and short enough to
 * stay well inside the hour of inactivity that ends a session, so an unanswered
 * ask resolves while the session is still there to resolve it into. See ADR-022.
 *
 * Configurable per-device via tunnelcode.json (timeouts.answerMinutes), sent by
 * the CLI on register. This constant is the server-wide fallback when the CLI
 * does not send one.
 */
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A tool call an engine is holding still for, waiting to be allowed.
 *
 * Kept in memory alongside the turn it belongs to. An ask cannot outlive its
 * turn, and a turn cannot outlive the CLI connection that owns it, so there is
 * nothing here a restart could usefully bring back. See ADR-006 and ADR-022.
 */
export interface PendingPermission {
  /** The engine's own id for the ask, which is what it will be answered with. */
  id: string;
  turnId: string;
  sessionId: string;
  deviceId: string;
  conversationId: string;
  tool: string;
  title: string;
  target?: string;
  reason?: string;
  details: string[];
  suggestions: string[];
  createdAt: number;
  /** When the ask stops being answerable, so every browser agrees on the deadline. */
  expiresAt: number;
}

export interface PermissionServiceOptions {
  /** Overridden in tests, which cannot wait ten minutes for a real deadline. */
  timeoutMs?: number;
}

/**
 * Holds the asks that are waiting for an answer.
 *
 * Keyed by turn as well as by ask id, because the id is minted by the engine
 * rather than by this server. Two engines on two devices choosing the same id is
 * not something this has to be lucky about.
 */
export class PermissionService {
  private readonly byKey = new Map<string, PendingPermission>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly timeoutMs: number;

  constructor(options: PermissionServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? ANSWER_TIMEOUT_MS;
  }

  private static key(turnId: string, permissionId: string): string {
    // A separator that cannot appear in either id, so two different pairs can
    // never collapse into one key.
    return `${turnId}\u0000${permissionId}`;
  }

  /**
   * Records an ask and starts its deadline.
   *
   * The expiry handler is supplied per ask rather than held on the service, so
   * deciding what an expiry means stays with the caller that knows how to reach
   * the engine and the browsers.
   *
   * An optional timeoutMs overrides the service default for this specific ask,
   * allowing per-device timeouts read from the CLI config.
   */
  add(
    input: Omit<PendingPermission, 'createdAt' | 'expiresAt'>,
    onExpired: (pending: PendingPermission) => void,
    timeoutMs?: number,
  ): PendingPermission {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const createdAt = Date.now();
    const pending: PendingPermission = {
      ...input,
      createdAt,
      expiresAt: createdAt + effectiveTimeout,
    };

    const key = PermissionService.key(pending.turnId, pending.id);
    this.byKey.set(key, pending);

    const timer = setTimeout(() => {
      // Dropped before the handler runs, so an expiry cannot be answered as well.
      if (this.resolve(pending.turnId, pending.id) !== undefined) {
        onExpired(pending);
      }
    }, effectiveTimeout);

    // The server stays alive on its listening socket, so this timer has no
    // business holding the process open by itself.
    timer.unref();
    this.timers.set(key, timer);

    return pending;
  }

  /**
   * Finds an ask a session is entitled to answer.
   *
   * The conversation is matched as well as the id, because the id comes from an
   * engine and only the pairing of the two is meaningfully unique.
   */
  find(
    sessionId: string,
    conversationId: string,
    permissionId: string,
  ): PendingPermission | undefined {
    for (const pending of this.byKey.values()) {
      if (
        pending.id === permissionId &&
        pending.sessionId === sessionId &&
        pending.conversationId === conversationId
      ) {
        return pending;
      }
    }

    return undefined;
  }

  /**
   * Asks still waiting on a session.
   *
   * Read when a browser attaches: a phone that locked mid-turn is the ordinary
   * case, and the engine is holding still until one of these is answered.
   */
  listBySession(sessionId: string): PendingPermission[] {
    const waiting: PendingPermission[] = [];

    for (const pending of this.byKey.values()) {
      if (pending.sessionId === sessionId) {
        waiting.push(pending);
      }
    }

    return waiting;
  }

  /** Takes an ask out of the waiting set, so it can only be answered once. */
  resolve(turnId: string, permissionId: string): PendingPermission | undefined {
    const key = PermissionService.key(turnId, permissionId);
    const pending = this.byKey.get(key);

    if (pending === undefined) {
      return undefined;
    }

    this.byKey.delete(key);
    this.clearTimer(key);

    return pending;
  }

  /** Drops every ask belonging to a turn that has ended. */
  removeByTurn(turnId: string): PendingPermission[] {
    return this.removeWhere((pending) => pending.turnId === turnId);
  }

  /** Drops every ask belonging to a device whose CLI went away. */
  removeByDevice(deviceId: string): PendingPermission[] {
    return this.removeWhere((pending) => pending.deviceId === deviceId);
  }

  private removeWhere(matches: (pending: PendingPermission) => boolean): PendingPermission[] {
    const dropped: PendingPermission[] = [];

    for (const [key, pending] of this.byKey) {
      if (!matches(pending)) {
        continue;
      }

      dropped.push(pending);
      this.byKey.delete(key);
      this.clearTimer(key);
    }

    return dropped;
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);

    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
