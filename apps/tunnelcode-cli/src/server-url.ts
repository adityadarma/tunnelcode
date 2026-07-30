const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '3000';
const FALLBACK_URL = 'http://localhost:3000';

/**
 * Replaced at bundle time with the deployment the published CLI should talk to.
 * Left undefined when running from a checkout, where localhost is the sane guess.
 */
declare const TUNNELCODE_BUNDLED_SERVER_URL: string | undefined;

function bundledServerUrl(): string | undefined {
  // Guarded because the identifier only exists in a bundled build.
  const value =
    typeof TUNNELCODE_BUNDLED_SERVER_URL === 'string' ? TUNNELCODE_BUNDLED_SERVER_URL : undefined;

  return value === undefined || value === '' ? undefined : value;
}

/**
 * Resolves the server URL to write into a fresh global config.
 *
 * Precedence, most specific first:
 *
 * 1. the --server flag, an explicit choice for this run
 * 2. TUNNELCODE_SERVER_URL, an explicit choice for this environment
 * 3. HOST and PORT, which also configure the server itself
 * 4. the URL baked in when the CLI was published
 * 5. localhost, which is where a locally started server listens
 *
 * A published CLI has no repository to read, so step 4 is what makes it usable
 * without arguments. It stays a default: config always wins once written.
 */
export function resolveDefaultServerUrl(): string {
  return serverUrlFromEnvironment() ?? bundledServerUrl() ?? FALLBACK_URL;
}

/**
 * Server URL described by the environment, or undefined when it says nothing.
 *
 * Used to override a stored config at run time: a config written earlier records
 * the server that was reachable then, and pointing the agent somewhere else
 * should not require rewriting it. Returning undefined keeps the stored value in
 * charge, which is what makes this an override rather than a replacement.
 */
export function serverUrlFromEnvironment(): string | undefined {
  const explicit = process.env['TUNNELCODE_SERVER_URL'];

  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const host = process.env['HOST'];
  const port = process.env['PORT'];

  if ((host === undefined || host === '') && (port === undefined || port === '')) {
    return undefined;
  }

  // A bind address of 0.0.0.0 is not something a client can connect to.
  const resolvedHost = host === undefined || host === '' ? DEFAULT_HOST : host;
  const reachable =
    resolvedHost === '0.0.0.0' || resolvedHost === '::' ? DEFAULT_HOST : resolvedHost;
  const resolvedPort = port === undefined || port === '' ? DEFAULT_PORT : port;

  return `http://${reachable}:${resolvedPort}`;
}
