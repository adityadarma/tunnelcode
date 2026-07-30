import type { ServerToCliMessage } from '@tunnelcode/protocol';

/**
 * Something that can receive a WebSocket frame. Kept minimal so the registry
 * does not depend on a specific WebSocket implementation.
 */
export interface CliConnection {
  send(data: string): void;
}

/**
 * Tracks the live CLI connection for each device.
 *
 * This is the only path an approval can travel, which is what makes "only the
 * CLI can approve" enforceable. See ADR-014.
 */
export class CliRegistry {
  private readonly connections = new Map<string, CliConnection>();

  add(deviceId: string, connection: CliConnection): void {
    this.connections.set(deviceId, connection);
  }

  remove(deviceId: string): void {
    this.connections.delete(deviceId);
  }

  /**
   * Removes a device only when it is still held by this connection, reporting
   * whether it did.
   *
   * A reconnecting CLI can register its new socket before the old one reports
   * closed. Removing unconditionally would then tear down the session that just
   * came back, so a superseded socket has to leave the state alone.
   */
  removeIf(deviceId: string, connection: CliConnection): boolean {
    if (this.connections.get(deviceId) !== connection) {
      return false;
    }

    this.connections.delete(deviceId);
    return true;
  }

  isConnected(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  /**
   * Sends a message to a device. Returns false when the device is not connected,
   * so callers can treat a missing CLI as a normal outcome.
   */
  send(deviceId: string, message: ServerToCliMessage): boolean {
    const connection = this.connections.get(deviceId);
    if (connection === undefined) {
      return false;
    }

    connection.send(JSON.stringify(message));
    return true;
  }
}
