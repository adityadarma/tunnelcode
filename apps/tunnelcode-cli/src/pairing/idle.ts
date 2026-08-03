/** One hour without conversation ends the session. */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export interface IdleTimerOptions {
  onExpired: () => void;
  timeoutMs?: number;
}

/**
 * Ends the session after a period without conversation.
 *
 * Only messages reset the timer. Heartbeats and browser reconnects deliberately
 * do not, because a heartbeat runs for as long as the browser stays open and
 * would keep the timeout from ever being reached.
 * See PROJECT.md (Pairing Code Lifetime).
 */
export class IdleTimer {
  private readonly timeoutMs: number;
  private readonly onExpired: () => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: IdleTimerOptions) {
    this.timeoutMs = options.timeoutMs ?? IDLE_TIMEOUT_MS;
    this.onExpired = options.onExpired;
  }

  /**
   * Starts the clock, unless it is already running.
   *
   * Called on every registration, and a registration is not conversation: the CLI
   * reconnects on its own after any outage, and restarting the clock there would hand
   * the session a fresh hour for something nobody did. See ADR-044.
   */
  start(): void {
    if (this.timer === undefined) {
      this.reset();
    }
  }

  /** Called on conversation activity, in either direction. */
  reset(): void {
    this.stop();
    this.timer = setTimeout(this.onExpired, this.timeoutMs);
    // Do not hold the process open just to wait for the timeout.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
