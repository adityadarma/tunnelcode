import type { SessionRepository } from '../db/session-repository.js';

/**
 * How often a registered device's sessions are checked for having expired.
 *
 * The windows being watched are an hour (idle) and twelve hours (the ceiling), so
 * a minute is far finer than it needs to be and still cheap: one indexed count per
 * connected device.
 */
const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

export interface SessionExpiryWatchOptions {
  deviceId: string;
  sessionRepository: SessionRepository;
  /** Told once every session of this device has stopped being live. */
  onExpired: () => void;
  /** True while the server is tearing down, when the database is already closing. */
  isClosing: () => boolean;
  /** Shortened by tests, which cannot wait out the real one. */
  intervalMs?: number;
}

/**
 * Tells a CLI when the sessions it is serving have expired.
 *
 * Session expiry on the server is lazy: the idle window and the twelve hour ceiling
 * are a predicate every read applies, nothing writes `endedAt` when either passes,
 * and nothing informed the machine. The CLI measures its own idle window and has
 * no notion of the ceiling at all, so its socket stayed open and `isConnected`
 * stayed true while every browser attaching to the same session was answered
 * `Unknown session.` — connected in the terminal, unknown in the browser. See
 * ADR-026 and ADR-039.
 *
 * Armed rather than started: a device that has just registered legitimately has no
 * live session, because it is showing a pairing code nobody has scanned yet. The
 * watch only begins to mean something once a session has existed, and from then on
 * the count falling to zero is that session being over.
 *
 * Returns the call that stops the watch.
 */
export function startSessionExpiryWatch(options: SessionExpiryWatchOptions): () => void {
  const { deviceId, sessionRepository, onExpired, isClosing } = options;

  let armed = false;

  const timer = setInterval(() => {
    // The database is closing and every socket is being dropped anyway, so a read
    // here would only fail and a stop would reach nobody.
    if (isClosing()) {
      return;
    }

    const live = sessionRepository.listLiveSessionIdsByDevice(deviceId).length;

    if (live > 0) {
      armed = true;
      return;
    }

    if (!armed) {
      return;
    }

    // Disarmed before notifying, so a CLI that stays connected through this is not
    // told the same thing once a minute forever.
    armed = false;
    onExpired();
  }, options.intervalMs ?? EXPIRY_CHECK_INTERVAL_MS);

  // Nothing should be held open just to watch a clock.
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}
