import { generateApprovalNumber, generateId, generateSessionToken } from './ids.js';

/** How long a browser has to be approved before its request expires. */
const PENDING_TTL_MS = 2 * 60 * 1000;

/**
 * A request waiting for the user to approve in the terminal. Holding this in
 * memory is deliberate: an unapproved request has no value to persist.
 * See ADR-006.
 */
export interface PendingRequest {
  id: string;
  deviceId: string;
  approvalNumber: string;
  createdAt: number;
  /**
   * The session this would revive, on a request from a browser that paired in an
   * earlier run of the CLI. Absent on a first pairing, which has no session yet.
   * See ADR-040.
   */
  sessionId?: string;
}

/**
 * A session exists only after the user approved the pairing request.
 *
 * Carries no activity timestamp. One used to live here and nothing ever read it,
 * which is how a session came to have no lifetime at all: the id that matters is
 * the persisted one, and it outlives this map. Activity is recorded on the row.
 * See ADR-026.
 */
export interface Session {
  id: string;
  deviceId: string;
  /**
   * The secret the browser will prove this session with, in the clear.
   *
   * Only here, and only until the browser has collected it: the database keeps a
   * hash. Living in memory is what stops the token from being readable anywhere
   * except the one response that sets the cookie. See ADR-041.
   */
  token: string;
  createdAt: number;
}

export type ApprovalOutcome =
  | { status: 'approved'; session: Session }
  /** An existing session the terminal has agreed to serve again. See ADR-040. */
  | { status: 'resumed'; sessionId: string }
  | { status: 'rejected' }
  | { status: 'expired' }
  | { status: 'pending' }
  | { status: 'unknown' };

export class SessionService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, Session>();
  private readonly resolved = new Map<string, ApprovalOutcome>();
  /** The resume request in flight for a session, so one ask is not raised twice. */
  private readonly resuming = new Map<string, string>();

  /**
   * Creates a pending request for a device. The approval number is generated
   * here, on the server, so it never travels through the QR URL.
   */
  createPending(deviceId: string): PendingRequest {
    const request: PendingRequest = {
      id: generateId(),
      deviceId,
      approvalNumber: generateApprovalNumber(),
      createdAt: Date.now(),
    };

    this.pending.set(request.id, request);
    return request;
  }

  /**
   * Creates, or reuses, the request that asks the terminal to serve an existing
   * session again.
   *
   * Reused rather than replaced while one is still waiting, because the browser
   * re-attaches whenever its socket reconnects and every new request would be
   * another keypress asked of somebody who is already looking at one.
   */
  createPendingResume(
    deviceId: string,
    sessionId: string,
  ): { request: PendingRequest; asked: boolean } {
    const inFlight = this.resuming.get(sessionId);
    const existing = inFlight === undefined ? undefined : this.getPending(inFlight);

    // asked says whether the terminal has already been given this question, so a
    // second browser arriving does not put the same number in front of the user
    // twice.
    if (existing !== undefined && existing.deviceId === deviceId) {
      return { request: existing, asked: true };
    }

    const request: PendingRequest = {
      id: generateId(),
      deviceId,
      approvalNumber: generateApprovalNumber(),
      createdAt: Date.now(),
      sessionId,
    };

    this.pending.set(request.id, request);
    this.resuming.set(sessionId, request.id);
    return { request, asked: false };
  }

  getPending(requestId: string): PendingRequest | undefined {
    const request = this.pending.get(requestId);
    if (request === undefined) {
      return undefined;
    }

    if (Date.now() - request.createdAt > PENDING_TTL_MS) {
      this.pending.delete(requestId);
      this.resolved.set(requestId, { status: 'expired' });
      return undefined;
    }

    return request;
  }

  /**
   * Approves a request and opens a session. Only ever called for a message that
   * arrived on the CLI connection owning the device.
   */
  approve(requestId: string, deviceId: string): ApprovalOutcome {
    const request = this.getPending(requestId);

    if (request === undefined) {
      return this.resolved.get(requestId) ?? { status: 'unknown' };
    }

    if (request.deviceId !== deviceId) {
      return { status: 'unknown' };
    }

    // A resume approves a session that already exists, so there is nothing to
    // create and nothing to record for a browser to poll: the browser is on a
    // socket, and it hears about this there. See ADR-040.
    if (request.sessionId !== undefined) {
      this.pending.delete(requestId);
      this.resuming.delete(request.sessionId);
      return { status: 'resumed', sessionId: request.sessionId };
    }

    const session: Session = {
      id: generateId(),
      deviceId,
      token: generateSessionToken(),
      createdAt: Date.now(),
    };

    this.pending.delete(requestId);
    this.sessions.set(session.id, session);
    const outcome: ApprovalOutcome = { status: 'approved', session };
    this.resolved.set(requestId, outcome);

    // Any other pending pairing requests for the same device are answered by the
    // same approval: a browser that submitted the code twice (e.g. React StrictMode
    // double-firing an effect) polls one of them, and the terminal only answered
    // once. Without this, the duplicate stays pending forever.
    for (const [id, other] of this.pending) {
      if (other.deviceId === deviceId && other.sessionId === undefined) {
        this.pending.delete(id);
        this.resolved.set(id, outcome);
      }
    }

    return outcome;
  }

  /**
   * Refuses a request. Returns which kind was refused, so a refused resume can
   * retire the session it named rather than only declining this connection.
   */
  reject(requestId: string, deviceId: string): { outcome: ApprovalOutcome; sessionId?: string } {
    const request = this.getPending(requestId);

    if (request === undefined) {
      return { outcome: this.resolved.get(requestId) ?? { status: 'unknown' } };
    }

    if (request.deviceId !== deviceId) {
      return { outcome: { status: 'unknown' } };
    }

    this.pending.delete(requestId);
    const outcome: ApprovalOutcome = { status: 'rejected' };

    if (request.sessionId !== undefined) {
      this.resuming.delete(request.sessionId);
      return { outcome, sessionId: request.sessionId };
    }

    // Recorded only for a pairing request, which is the one a browser polls for.
    this.resolved.set(requestId, outcome);
    return { outcome };
  }

  /**
   * Reports the outcome of a request the browser is waiting on. Checking pending
   * first lets an expired request move into the resolved map before it is read.
   */
  outcomeOf(requestId: string): ApprovalOutcome {
    if (this.getPending(requestId) !== undefined) {
      return { status: 'pending' };
    }

    return this.resolved.get(requestId) ?? { status: 'unknown' };
  }

  findSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Drops everything owned by a device once its CLI disconnects. */
  removeByDevice(deviceId: string): void {
    for (const [id, request] of this.pending) {
      if (request.deviceId === deviceId) {
        this.pending.delete(id);

        // A resume nobody answered before the terminal went away is not waiting on
        // anything any more, and leaving it here would have the next attach shown a
        // number the terminal is no longer asking about.
        if (request.sessionId !== undefined) {
          this.resuming.delete(request.sessionId);
        }
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId) {
        this.sessions.delete(id);
      }
    }
  }
}
