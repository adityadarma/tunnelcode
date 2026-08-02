import { randomUUID } from 'node:crypto';
import { ENGINE_TEXT_MAX_LENGTH } from '@tunnelcode/protocol';

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

/**
 * A turn that was dropped without finishing, with whatever it had streamed.
 *
 * The text travels with it because the buffer dies with the turn, and a turn cut
 * off mid-answer is exactly the case where what it had already said still has to
 * be kept. See ADR-033.
 */
export interface AbandonedTurn extends Turn {
  pendingText: string;
}

export class TurnService {
  private readonly byId = new Map<string, Turn>();

  /**
   * What the engine has streamed for a turn and not yet stored as a message.
   *
   * Held so a browser that attaches mid-answer can be given the answer as it
   * stands. It is not persisted and it is not written per delta: this is the same
   * text the turn will store once, when it flushes or finishes, which is what
   * keeps writes proportional to messages rather than tokens. See ADR-008 and
   * ADR-032.
   */
  private readonly streamed = new Map<string, string>();

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

  /**
   * Keeps a fragment of the answer for as long as it is unstored.
   *
   * Ignored for a turn that is not running, so a late delta cannot leave text
   * behind for a turn nobody will read it from. The oldest text is dropped once
   * the buffer reaches the length a message is allowed to be, since what a
   * returning browser is watching is the end of the answer, and the stored
   * message is what carries the whole of it.
   */
  appendText(turnId: string, text: string): void {
    if (!this.byId.has(turnId)) {
      return;
    }

    const combined = (this.streamed.get(turnId) ?? '') + text;

    this.streamed.set(
      turnId,
      combined.length > ENGINE_TEXT_MAX_LENGTH
        ? combined.slice(combined.length - ENGINE_TEXT_MAX_LENGTH)
        : combined,
    );
  }

  /** The unstored part of an answer, empty when there is none. */
  textOf(turnId: string): string {
    return this.streamed.get(turnId) ?? '';
  }

  /**
   * Forgets the buffered text, called once it has been stored as a message.
   *
   * Without this the flushed text would be sent again on the next attach and
   * appear twice: once from the transcript and once as the answer in progress.
   */
  clearText(turnId: string): void {
    this.streamed.delete(turnId);
  }

  finish(turnId: string): void {
    this.byId.delete(turnId);
    this.streamed.delete(turnId);
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
  removeByDevice(deviceId: string): AbandonedTurn[] {
    const dropped: AbandonedTurn[] = [];

    for (const [id, turn] of this.byId) {
      if (turn.deviceId === deviceId) {
        dropped.push({ ...turn, pendingText: this.textOf(id) });
        this.byId.delete(id);
        this.streamed.delete(id);
      }
    }

    return dropped;
  }
}
