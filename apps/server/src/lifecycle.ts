/**
 * Tracks whether the server is shutting down.
 *
 * Socket close handlers run while the server is tearing down, and by then the
 * database may already be closed. Cleanup that only matters for a live server is
 * skipped once shutdown has started.
 */
export interface Lifecycle {
  isClosing(): boolean;
  markClosing(): void;
}

export function createLifecycle(): Lifecycle {
  let closing = false;

  return {
    isClosing: () => closing,
    markClosing: () => {
      closing = true;
    },
  };
}
