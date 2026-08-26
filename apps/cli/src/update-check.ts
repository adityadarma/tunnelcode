import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateStatePath } from '@tunnelcode/config';
import { isRecord } from '@tunnelcode/shared';
import { readVersion } from './version.js';
import { bold, green } from './style.js';
import { readJsonFile, writeJsonFileQuiet } from './update-state.js';

const execFileAsync = promisify(execFile);

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
 * Detects which package manager installed the global `tunnelcode` binary.
 *
 * Checks common global directories to determine if it was installed via npm,
 * yarn, or pnpm.
 */
async function detectPackageManager(): Promise<'npm' | 'pnpm' | 'yarn'> {
  try {
    const { stdout } = await execFileAsync('npm', ['root', '-g']);
    const npmGlobal = stdout.trim();
    const binPath = process.argv[1] ?? '';

    if (binPath.includes('.pnpm')) return 'pnpm';
    if (binPath.includes('yarn')) return 'yarn';
    if (binPath.includes(npmGlobal) || binPath.includes('npm')) return 'npm';
  } catch {
    // Fall through to default.
  }

  return 'npm';
}

interface UpdateState {
  /** Version a background install last finished writing to disk. */
  installedVersion: string;
}

function parseUpdateState(value: unknown): UpdateState | undefined {
  if (!isRecord(value) || typeof value['installedVersion'] !== 'string') {
    return undefined;
  }

  return { installedVersion: value['installedVersion'] };
}

/**
 * Installs the given version in the background and records it once done.
 *
 * The binary this process is running stays the old one: Node has already loaded
 * it into memory, and nothing short of exiting swaps that out. The state file is
 * how the next start finds out a newer one is already on disk waiting for it.
 *
 * Runs to completion but is never awaited by the caller, so the menu is never
 * blocked on it. A failure here is silent: the manual `tunnelcode update`
 * command remains as a fallback, and there is nothing useful to tell a user who
 * has not asked for anything yet.
 */
async function installInBackground(version: string): Promise<void> {
  const pm = await detectPackageManager();
  const commands: Record<typeof pm, [string, string[]]> = {
    npm: ['npm', ['install', '-g', `tunnelcode@${version}`]],
    pnpm: ['pnpm', ['add', '-g', `tunnelcode@${version}`]],
    yarn: ['yarn', ['global', 'add', `tunnelcode@${version}`]],
  };

  const [command, commandArgs] = commands[pm];

  try {
    await execFileAsync(command, commandArgs);
    await writeJsonFileQuiet(updateStatePath(), { installedVersion: version });
  } catch {
    // A failed background install costs the user nothing: they are still on the
    // version they started this run with, and can still run the command by hand.
  }
}

/**
 * Checks the npm registry for a newer version, installing it in the background
 * when one exists.
 *
 * This runs in the background and never throws or delays the caller. A network
 * failure or timeout is silently ignored — the user should never wait for an
 * update check.
 */
export async function checkForUpdate(): Promise<void> {
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

    if (!response.ok) return;

    const data = (await response.json()) as { version?: string };
    const latest = data.version;

    if (typeof latest !== 'string') return;

    const current = readVersion();

    if (!isNewer(current, latest)) return;

    const state = parseUpdateState(await readJsonFile(updateStatePath()));

    // Already installed by an earlier run and just waiting on a restart: no
    // reason to install it again on every start until then.
    if (state?.installedVersion === latest) return;

    await installInBackground(latest);
  } catch {
    // Network error, timeout, parse failure — all fine, just skip.
  }
}

/**
 * Reports a newly installed version still waiting for this process to restart
 * into it, or undefined when there is nothing to say.
 *
 * Read on every start rather than cleared after the first read: what ends the
 * notice is the binary on disk finally matching what was installed, which only
 * happens once the user actually restarts.
 */
export async function pendingUpdateNotice(): Promise<string | undefined> {
  const state = parseUpdateState(await readJsonFile(updateStatePath()));

  if (state === undefined || state.installedVersion === readVersion()) {
    return undefined;
  }

  return (
    green('✓') + ` Update installed ${bold(`v${state.installedVersion}`)}` + ' · Restart to update.'
  );
}
