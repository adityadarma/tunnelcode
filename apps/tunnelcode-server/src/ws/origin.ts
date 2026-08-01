/**
 * Whether a WebSocket handshake may proceed, judged by where it came from.
 *
 * WebSocket is not subject to CORS: a browser will open a socket to this server
 * from any page and start sending on it. The session id is still needed to attach,
 * so this is not the only thing standing in the way, but it is the only thing
 * standing in the way of a page the user merely visited trying at all, and of the
 * same trick played through a rebound DNS name.
 *
 * A handshake with no Origin is allowed: the CLI is not a browser and sends none.
 * Withholding the header is not a way in for a page, because a browser always
 * sends it and does not let script remove it. See ADR-028.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  /**
   * Hosts this request is addressed to, in `host:port` form. More than one because
   * a proxy may forward the name the browser used alongside the one it dialled.
   */
  hosts: readonly (string | undefined)[],
): boolean {
  if (origin === undefined || origin === '') {
    return true;
  }

  // 'null' is what a sandboxed iframe and a file:// page send. It names no host,
  // so it can never match one, and it must not be compared as text either.
  if (origin === 'null') {
    return false;
  }

  let host: string;

  try {
    host = new URL(origin).host;
  } catch {
    // Not a URL at all, which no browser produces.
    return false;
  }

  if (host === '') {
    return false;
  }

  return hosts.some(
    (candidate) => candidate !== undefined && candidate !== '' && candidate === host,
  );
}
