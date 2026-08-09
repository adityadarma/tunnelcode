import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

/** Bytes behind a session token. Far past guessing, and short enough for a header. */
const SESSION_TOKEN_BYTES = 32;

const APPROVAL_DIGITS = 4;
const APPROVAL_MAX = 10 ** APPROVAL_DIGITS;

/**
 * Generates the 4 digit approval number shown in both the browser and the
 * terminal. Uses the crypto random source, not Math.random, because this value
 * guards pairing. Padded so a leading zero is never lost.
 */
export function generateApprovalNumber(): string {
  return String(randomInt(0, APPROVAL_MAX)).padStart(APPROVAL_DIGITS, '0');
}

export function generateId(): string {
  return randomUUID();
}

/**
 * Generates the secret a browser proves its session with.
 *
 * Separate from the session id because the id is an address: it travels in paths
 * and is remembered by the page, while this is only ever in a cookie the page
 * cannot read. base64url so it survives a cookie value untouched. See ADR-041.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a secret for storage.
 *
 * Only the hash is written down, so a database that is read somewhere it should
 * not be does not hand over working credentials. No salt and no stretching: these
 * are 32 random bytes rather than passwords, so there is nothing to guess and
 * nothing a table of precomputed hashes could cover.
 */
function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Hashes the token a browser proves its session with. See ADR-041. */
export function hashSessionToken(token: string): string {
  return hash(token);
}

/**
 * Hashes the id a CLI run introduces itself with.
 *
 * Stored on the sessions that run approved, so a server that restarted can tell it
 * is talking to the same run rather than asking the terminal about a machine that
 * never went anywhere. Hashed for the same reason the token is: what is written down
 * should not be usable. See ADR-043.
 */
export function hashRunId(runId: string): string {
  return hash(runId);
}
