import { randomUUID } from 'node:crypto';

/**
 * A prompt that was sent to a device and is waiting for its answer.
 *
 * Kept in memory because a turn only matters while it streams. The finished
 * answer is what gets stored, not the turn itself. See ADR-006 and ADR-008.
 */
export interface Turn {
  id: string;
  sessionId: string;
  deviceId: string;
  conversationId: string;
  /**
   * Engine answering this turn.
   *
   * A device runs several engines now, so the device alone no longer says which
   * one produced an engine session id, and an id only means something to the
   * engine that issued it. Recorded here because this is the only thing that
   * knows which engine the prompt was actually sent to. See ADR-020.
   */
  engine: string;
  startedAt: number;
}

export class TurnService {
  private readonly byId = new Map<string, Turn>();

  start(input: Omit<Turn, 'id' | 'startedAt'>): Turn {
    const turn: Turn = {
      id: randomUUID(),
      startedAt: Date.now(),
      ...input,
    };

    this.byId.set(turn.id, turn);
    return turn;
  }

  /**
   * Looks up a turn, but only when it belongs to the device reporting it. A CLI
   * can therefore never write into a turn started for another device.
   */
  findForDevice(turnId: string, deviceId: string): Turn | undefined {
    const turn = this.byId.get(turnId);
    return turn?.deviceId === deviceId ? turn : undefined;
  }

  finish(turnId: string): void {
    this.byId.delete(turnId);
  }

  /**
   * The turn a session is waiting on, if any.
   *
   * Read when a browser attaches: a refresh closes the socket without ending the
   * turn, so this is how a reattaching browser learns an answer is still coming
   * instead of offering a prompt that would be refused.
   */
  findActiveForSession(sessionId: string): Turn | undefined {
    for (const turn of this.byId.values()) {
      if (turn.sessionId === sessionId) {
        return turn;
      }
    }

    return undefined;
  }

  /**
   * True while a device is still answering. A device runs one prompt at a time,
   * so this is checked before a prompt is stored: refusing afterwards would
   * leave a question in the history that never gets an answer.
   */
  hasActiveForDevice(deviceId: string): boolean {
    for (const turn of this.byId.values()) {
      if (turn.deviceId === deviceId) {
        return true;
      }
    }

    return false;
  }

  /** Drops every turn owned by a device whose CLI disconnected. */
  removeByDevice(deviceId: string): Turn[] {
    const dropped: Turn[] = [];

    for (const [id, turn] of this.byId) {
      if (turn.deviceId === deviceId) {
        dropped.push(turn);
        this.byId.delete(id);
      }
    }

    return dropped;
  }
}
