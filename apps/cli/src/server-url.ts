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
 * Resolves the server URL to offer when the setup menu has none stored yet.
 *
 * Precedence, most specific first:
 *
 * 1. the URL baked in when the CLI was published
 * 2. localhost, which is where a locally started server listens
 *
 * A published CLI has no repository to read, so step 1 is what makes it usable
 * out of the box. It stays a default: the stored config always wins once written,
 * and the only way to change it is the setup menu. The environment is deliberately
 * not consulted, so an agent that can read and write files on this machine cannot
 * be pointed at another server by a variable or a stray .env file. See ADR-018.
 */
export function resolveDefaultServerUrl(): string {
  return bundledServerUrl() ?? FALLBACK_URL;
}
