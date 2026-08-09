import { execSync } from 'node:child_process';
import { readVersion } from '../version.js';
import { writeErr, writeOut } from '../output.js';
import { bold, cyan, dim, green, red, yellow } from '../style.js';

/** npm registry endpoint for the package metadata. */
const REGISTRY_URL = 'https://registry.npmjs.org/tunnelcode/latest';

/** How long to wait for the registry check. */
const TIMEOUT_MS = 10000;

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
function detectPackageManager(): 'npm' | 'pnpm' | 'yarn' {
  try {
    const npmGlobal = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const binPath = process.argv[1] ?? '';

    if (binPath.includes('.pnpm')) return 'pnpm';
    if (binPath.includes('yarn')) return 'yarn';
    if (binPath.includes(npmGlobal) || binPath.includes('npm')) return 'npm';
  } catch {
    // Fall through to default.
  }

  return 'npm';
}

/**
 * Self-update command: checks for a newer version and installs it globally.
 *
 * Returns the process exit code.
 */
export async function runUpdate(): Promise<number> {
  const current = readVersion();

  writeOut(`Current version: ${bold(current)}`);
  writeOut('Checking for updates...');
  writeOut('');

  let latest: string;

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

    if (!response.ok) {
      writeErr('Failed to check for updates. Try again later.');
      return 1;
    }

    const data = (await response.json()) as { version?: string };

    if (typeof data.version !== 'string') {
      writeErr('Unexpected registry response.');
      return 1;
    }

    latest = data.version;
  } catch {
    writeErr('Could not reach the npm registry. Check your internet connection.');
    return 1;
  }

  if (!isNewer(current, latest)) {
    writeOut(green('✓') + ` Already on the latest version ${bold(current)}.`);
    return 0;
  }

  writeOut(`${yellow('⬆')} Updating ${dim(current)} → ${cyan(latest)}`);
  writeOut('');

  const pm = detectPackageManager();
  const commands: Record<string, string> = {
    npm: 'npm install -g tunnelcode@latest',
    pnpm: 'pnpm add -g tunnelcode@latest',
    yarn: 'yarn global add tunnelcode@latest',
  };

  const command = commands[pm] ?? 'npm install -g tunnelcode@latest';

  writeOut(dim(`$ ${command}`));
  writeOut('');

  try {
    execSync(command, { stdio: 'inherit' });
  } catch {
    writeOut('');
    writeErr(red('Update failed.'));
    writeErr(`Try running manually: ${bold(command)}`);
    return 1;
  }

  writeOut('');
  writeOut(green('✓') + ` Updated to ${bold(latest)}.`);

  return 0;
}
