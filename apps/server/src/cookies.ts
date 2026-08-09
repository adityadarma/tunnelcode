/**
 * The session cookie.
 *
 * The credential a browser proves its session with. Kept in a cookie rather than
 * handed to the page, because a cookie the page cannot read is a credential a
 * script that reaches the page cannot copy: the session id in local storage was
 * enough to drive an agent on the user's machine from anywhere. See ADR-041.
 */
export const SESSION_COOKIE = 'tunnelcode_session';

/** How long the cookie is offered for, matching the longest a session can live. */
const MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * Reads one cookie out of a request header.
 *
 * Written here rather than taken from a plugin: a header of `name=value` pairs is
 * a split, and a dependency that parses it would be one more thing to keep
 * current for no gain.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (part.slice(0, separator).trim() !== name) {
      continue;
    }

    const value = part.slice(separator + 1).trim();

    // An empty cookie is the shape a cleared one leaves behind, so it is absent
    // rather than a credential of zero length.
    return value === '' ? undefined : value;
  }

  return undefined;
}

/**
 * Builds the Set-Cookie value for a freshly approved session.
 *
 * `HttpOnly` is the point of the exercise. `SameSite=Strict` is what keeps another
 * site from making an authenticated request in the background, which matters more
 * here than on most servers: an authenticated request can approve a tool call.
 *
 * `Secure` is conditional because the usual deployment is a plain http address on
 * a home network, and a Secure cookie sent there is a cookie the browser throws
 * away, which would lock the user out rather than protect them.
 */
export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${String(MAX_AGE_SECONDS)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
