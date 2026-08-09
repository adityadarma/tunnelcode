import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * How long a browser should refuse to talk to this server without TLS.
 *
 * A year, which is the usual answer. Sent without includeSubDomains: a deployment
 * on an apex name would otherwise decide TLS policy for every sibling name the
 * user owns, which is not this server's call to make.
 */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Inline `<script>` blocks in a document.
 *
 * A block with a src attribute is a file, which `'self'` already covers, so only
 * the ones carrying code of their own are matched. Reading HTML with a regular
 * expression is only safe because the input is this project's own build output:
 * one hand written file plus the tags Vite adds to it.
 */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Base64 sha256 of every inline script in a document, in the form a CSP names
 * them.
 *
 * The theme has to be applied before the first paint or the wrong one is briefly
 * visible, which is why that script is inline rather than a file. Hashing it is
 * what lets the policy refuse every other inline script without also refusing the
 * one the app needs, and deriving the hash from the document that is actually
 * served means editing the script can never leave the policy behind.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = [...html.matchAll(INLINE_SCRIPT)]
    .map((match) => match[1])
    .filter((code): code is string => code !== undefined && code !== '')
    .map((code) => createHash('sha256').update(code, 'utf8').digest('base64'));

  return [...new Set(hashes)];
}

/**
 * The policy, with the inline scripts of the served document allowed by hash.
 *
 * Everything else is refused rather than described: this app loads nothing from
 * anywhere but itself.
 */
export function buildContentSecurityPolicy(scriptHashes: readonly string[]): string {
  const scriptSrc = ["'self'", ...scriptHashes.map((hash) => `'sha256-${hash}'`)].join(' ');

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    // What stops the approval card being framed by another page and clicked
    // through. Refusing a WebSocket handshake by origin cannot help here: inside a
    // frame the page is this server's own origin, so the handshake looks exactly
    // as it should, and the session is already in the frame's local storage.
    "frame-ancestors 'none'",
    // The composer and the pairing form both prevent their own submit, so this only
    // decides where one would go if that ever failed.
    "form-action 'self'",
    "img-src 'self' data:",
    // Tailwind compiles to a file, but React writes style attributes and a CSP
    // counts those as inline styles.
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSrc}`,
    // The session socket is same origin, which a CSP counts as 'self' for ws and
    // wss alike. The push subscription endpoint lives on the browser vendor's push
    // service (fcm.googleapis.com for Chrome, updates.push.services.mozilla.com for
    // Firefox), so it has to be reachable from here as well.
    "connect-src 'self' https://*.googleapis.com https://*.push.services.mozilla.com https://*.notify.windows.com",
    // The service worker is a same-origin script served from /sw.js.
    "worker-src 'self'",
  ].join('; ');
}

export interface SecurityHeadersOptions {
  /**
   * Where the built web app lives, so the document's inline scripts can be
   * hashed. Absent when the app was never built, which is how tests and a
   * server-only checkout run.
   */
  webRoot?: string;
}

/**
 * Reads the served document, or undefined when there is none to read.
 *
 * Synchronous on purpose: the policy is a constant for the life of the process,
 * and building it while routes are being registered is simpler than making every
 * response wait on a promise that always has the same answer.
 */
function readDocument(app: FastifyInstance, webRoot: string): string | undefined {
  try {
    return readFileSync(join(webRoot, 'index.html'), 'utf8');
  } catch {
    // The web app is not built. registerWeb says so already, and there is no
    // document to hash, so the policy simply names no inline script.
    app.log.debug('No index.html to hash for the content security policy.');
    return undefined;
  }
}

/**
 * Sets the response headers that decide what a browser may do with this server.
 *
 * Registered before every route so it covers all of them, including the ones a
 * plugin owns: a 429 from the rate limit and a static file are both responses a
 * browser applies a policy to.
 *
 * There is no user authentication in this version, so a session id in local
 * storage is the whole of what a paired browser holds. Framing is the part that
 * needed answering: without frame-ancestors, any page could load this app in an
 * iframe on the user's own origin and lay its own controls over the approval card,
 * turning a click anywhere on an attacker's page into Always allow on the paired
 * machine.
 */
export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions = {},
): void {
  const document = options.webRoot === undefined ? undefined : readDocument(app, options.webRoot);
  const policy = buildContentSecurityPolicy(
    document === undefined ? [] : inlineScriptHashes(document),
  );

  app.addHook('onSend', (request, reply, payload, done) => {
    reply.header('content-security-policy', policy);
    // frame-ancestors is the one that counts; this is for a browser too old to
    // read it.
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    // The document says the same in a meta tag, which only covers the document.
    // A pairing code arrives in the query string of the QR link, so every response
    // to that URL has to say it, not just the HTML.
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');

    // Only over TLS. Sent on a plain connection it is ignored by browsers and
    // misleading to anyone reading the response, and the default deployment is
    // http on loopback.
    if (request.protocol === 'https') {
      reply.header('strict-transport-security', `max-age=${String(HSTS_MAX_AGE_SECONDS)}`);
    }

    done(null, payload);
  });
}
