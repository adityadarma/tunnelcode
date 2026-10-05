/** One hour without conversation ends the session (default). */
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How long a session may live at all, however busy it is (default).
 *
 * The same twelve hours the server enforces as its ceiling. Mirrored here because
 * the server's copy is lazy: it is a predicate every read applies, so a session
 * past the ceiling is answered `Unknown session.` for the browser while nothing
 * ever told the machine. Without this the terminal kept saying connected and the
 * CLI only found out if a notification reached it. See ADR-039.
 */
const DEFAULT_MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Which window ran out, so the terminal can say why the session ended. */
export type IdleExpiry = 'idle' | 'lifetime';

export interface IdleTimerOptions {
  onExpired: (expiry: IdleExpiry) => void;
  timeoutMs?: number | undefined;
  maxLifetimeMs?: number | undefined;
}

/**
 * Ends the session after a period without conversation, or at its ceiling.
 *
 * Only messages reset the idle window. Heartbeats and browser reconnects
 * deliberately do not, because a heartbeat runs for as long as the browser stays
 * open and would keep the timeout from ever being reached.
 * See PROJECT.md (Pairing Code Lifetime).
 *
 * The ceiling is the one window activity cannot move. Resetting pushes the idle
 * deadline forward and nothing else, so a conversation that keeps going ends at the
 * ceiling rather than running forever: the server's own ceiling would have expired
 * the session there anyway, and the two sides disagreeing about that is exactly how
 * a CLI ends up connected to a session every browser is told is unknown.
 * See ADR-039.
 */
export class IdleTimer {
  private readonly timeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly onExpired: (expiry: IdleExpiry) => void;
  private timer: NodeJS.Timeout | undefined;
  /**
   * Whether the session has already been reported as over.
   *
   * Ending is final, so this fires once. Without it a reset arriving after the
   * ceiling had passed — a long turn finishing late — would report the session over
   * again every time, and the terminal would print its goodbye repeatedly.
   */
  private expired = false;
  /**
   * When the clock first started, which is what the ceiling is measured from.
   *
   * Set on the first start rather than on every one: a reconnect calls start again,
   * and measuring from there would hand the session a fresh twelve hours for
   * something nobody did. Undefined until the session has started at all.
   */
  private startedAt: number | undefined;

  constructor(options: IdleTimerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
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

  /**
   * Called on conversation activity, in either direction.
   *
   * The wait is whichever deadline comes first. A session near its ceiling gets a
   * short wait and then ends there, however busy it is.
   */
  reset(): void {
    this.stop();

    // The session is already over. A turn that finished after the ceiling passed
    // still reports its activity, and arming again would end the session a second
    // time.
    if (this.expired) {
      return;
    }

    const now = Date.now();
    this.startedAt ??= now;

    const untilCeiling = this.startedAt + this.maxLifetimeMs - now;

    // Already past the ceiling, which a long turn finishing can land on. Fired on a
    // timer rather than inline so a caller is never re-entered from its own reset.
    if (untilCeiling <= 0) {
      this.timer = setTimeout(() => {
        this.fire('lifetime');
      }, 0);
      this.timer.unref();
      return;
    }

    const expiry: IdleExpiry = untilCeiling <= this.timeoutMs ? 'lifetime' : 'idle';

    this.timer = setTimeout(
      () => {
        this.fire(expiry);
      },
      Math.min(this.timeoutMs, untilCeiling),
    );
    // Do not hold the process open just to wait for the timeout.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Reports the session over, once. */
  private fire(expiry: IdleExpiry): void {
    if (this.expired) {
      return;
    }

    this.expired = true;
    this.onExpired(expiry);
  }
}
