import { SESSION_COOKIE, readCookie } from './cookies.js';
import { hashSessionToken } from './services/ids.js';
import type { SessionDetail, SessionRepository } from './db/session-repository.js';

/**
 * Works out which session is calling.
 *
 * One place, used by the routes and by both halves of the WebSocket, because the
 * question is the same everywhere and a second answer to it would eventually be a
 * different answer. The session id in the path or in an attach message is an
 * address; this is the claim. See ADR-041.
 *
 * Returns undefined for a caller with no cookie, a cookie that matches no session,
 * and a session that has ended, gone idle, or run out its twelve hours: from the
 * outside those are one case, and telling them apart in a reply would only confirm
 * which ids are real.
 */
export function authenticate(
  sessions: SessionRepository,
  cookieHeader: string | undefined,
): SessionDetail | undefined {
  const token = readCookie(cookieHeader, SESSION_COOKIE);

  if (token === undefined) {
    return undefined;
  }

  return sessions.findSessionByToken(hashSessionToken(token));
}
