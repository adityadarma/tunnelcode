export interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Manages request/response correlation with timeouts.
 *
 * The server sends a request to the CLI over WebSocket and waits for a matching
 * response keyed by a unique request id. If the CLI does not respond within the
 * configured timeout, the promise rejects and the entry is cleaned up so any
 * stale response arriving later is silently discarded.
 */
export class PendingRequestRegistry<T> {
  private readonly pending = new Map<string, PendingRequest<T>>();

  /**
   * Registers a request and returns a promise that resolves when the
   * CLI responds or rejects on timeout/disconnect.
   */
  create(requestId: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Request timed out.'));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Resolves a pending request with the CLI's response.
   * Returns false if no pending request matches (already timed out).
   */
  resolve(requestId: string, value: T): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(value);
    return true;
  }

  /**
   * Rejects all pending requests for a disconnected device.
   */
  rejectAll(reason: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
  }
}
