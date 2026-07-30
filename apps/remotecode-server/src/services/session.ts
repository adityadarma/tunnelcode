import { generateApprovalNumber, generateId } from './ids.js';

/** How long a browser has to be approved before its request expires. */
const PENDING_TTL_MS = 2 * 60 * 1000;

/**
 * A pairing request waiting for the user to approve in the terminal. Holding
 * this in memory is deliberate: an unapproved request has no value to persist.
 * See ADR-006.
 */
export interface PendingRequest {
  id: string;
  deviceId: string;
  approvalNumber: string;
  createdAt: number;
}

/**
 * A session exists only after the user approved the pairing request.
 */
export interface Session {
  id: string;
  deviceId: string;
  createdAt: number;
  lastActivityAt: number;
}

export type ApprovalOutcome =
  | { status: 'approved'; session: Session }
  | { status: 'rejected' }
  | { status: 'expired' }
  | { status: 'pending' }
  | { status: 'unknown' };

export class SessionService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, Session>();
  private readonly resolved = new Map<string, ApprovalOutcome>();

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

    const now = Date.now();
    const session: Session = {
      id: generateId(),
      deviceId,
      createdAt: now,
      lastActivityAt: now,
    };

    this.pending.delete(requestId);
    this.sessions.set(session.id, session);
    const outcome: ApprovalOutcome = { status: 'approved', session };
    this.resolved.set(requestId, outcome);
    return outcome;
  }

  reject(requestId: string, deviceId: string): ApprovalOutcome {
    const request = this.getPending(requestId);

    if (request === undefined) {
      return this.resolved.get(requestId) ?? { status: 'unknown' };
    }

    if (request.deviceId !== deviceId) {
      return { status: 'unknown' };
    }

    this.pending.delete(requestId);
    const outcome: ApprovalOutcome = { status: 'rejected' };
    this.resolved.set(requestId, outcome);
    return outcome;
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

  /**
   * Marks conversation activity. Only messages count, never heartbeats, so the
   * idle timeout can actually be reached. See PROJECT.md (Pairing Code Lifetime).
   */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) {
      session.lastActivityAt = Date.now();
    }
  }

  /** Drops everything owned by a device once its CLI disconnects. */
  removeByDevice(deviceId: string): void {
    for (const [id, request] of this.pending) {
      if (request.deviceId === deviceId) {
        this.pending.delete(id);
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.deviceId === deviceId) {
        this.sessions.delete(id);
      }
    }
  }
}
