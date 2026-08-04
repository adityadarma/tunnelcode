import { readVersion } from './version.js';
import { bold, yellow, dim, cyan } from './style.js';

/** npm registry endpoint for the package metadata. */
const REGISTRY_URL = 'https://registry.npmjs.org/tunnelcode/latest';

/** How long to wait before giving up on the registry. */
const TIMEOUT_MS = 5000;

/**
 * Compares two semver strings. Returns true when remote is newer than local.
 */
function isNewer(local: string, remote: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);
  const l = parse(local);
  const r = parse(remote);

  for (let i = 0; i < 3; i++) {
    const lp = l[i] ?? 0;
    const rp = r[i] ?? 0;
    if (rp > lp) return true;
    if (rp < lp) return false;
  }

  return false;
}

/**
 * Checks the npm registry for a newer version and prints a notice if one exists.
 *
 * This runs in the background and never throws or delays the caller. A network
 * failure or timeout is silently ignored — the user should never wait for an
 * update check.
 *
 * Returns the notice text to be printed by the caller after the interactive menu
 * is done, so it never interferes with ANSI cursor movement.
 */
export async function checkForUpdate(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timer);

    if (!response.ok) return undefined;

    const data = (await response.json()) as { version?: string };
    const latest = data.version;

    if (typeof latest !== 'string') return undefined;

    const current = readVersion();

    if (isNewer(current, latest)) {
      return (
        yellow('⬆ ') +
        bold(`Update available: ${dim(current)} → ${cyan(latest)}`) +
        dim('  Run ') +
        bold('tunnelcode update') +
        dim(' to upgrade.')
      );
    }

    return undefined;
  } catch {
    // Network error, timeout, parse failure — all fine, just skip.
    return undefined;
  }
}
