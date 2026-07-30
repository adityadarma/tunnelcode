import type { ServerToBrowserMessage } from '@tunnelcode/protocol';

export interface BrowserConnection {
  send(data: string): void;
}

/**
 * Tracks browser connections per session.
 *
 * A session can have several browsers open, so every one of them receives the
 * same stream. Keeping them in a set means a closed tab stops receiving without
 * disturbing the others.
 */
export class BrowserRegistry {
  private readonly bySession = new Map<string, Set<BrowserConnection>>();

  add(sessionId: string, connection: BrowserConnection): void {
    const existing = this.bySession.get(sessionId);

    if (existing === undefined) {
      this.bySession.set(sessionId, new Set([connection]));
      return;
    }

    existing.add(connection);
  }

  remove(sessionId: string, connection: BrowserConnection): void {
    const existing = this.bySession.get(sessionId);

    if (existing === undefined) {
      return;
    }

    existing.delete(connection);

    if (existing.size === 0) {
      this.bySession.delete(sessionId);
    }
  }

  /** Sends to every browser watching a session. */
  broadcast(sessionId: string, message: ServerToBrowserMessage): void {
    const connections = this.bySession.get(sessionId);

    if (connections === undefined) {
      return;
    }

    const payload = JSON.stringify(message);

    for (const connection of connections) {
      connection.send(payload);
    }
  }
}
