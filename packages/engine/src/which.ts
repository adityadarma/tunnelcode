import { spawn } from 'node:child_process';

/**
 * Full path of an executable plus how it has to be launched.
 */
export interface ResolvedCommand {
  path: string;
  /**
   * True when the target is a Windows batch shim (.cmd or .bat). Node cannot
   * execute those directly, they have to go through cmd.exe.
   */
  isBatch: boolean;
}

/**
 * Looks up an executable on PATH using the platform tool, so shims and aliases
 * resolve the same way a shell would resolve them.
 *
 * Returns undefined when the command is not found.
 */
export async function resolveCommand(command: string): Promise<ResolvedCommand | undefined> {
  const isWindows = process.platform === 'win32';
  const lookup = isWindows ? 'where' : 'which';

  const output = await new Promise<string | undefined>((resolve) => {
    const child = spawn(lookup, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      resolve(undefined);
    });
    child.on('close', (code) => {
      resolve(code === 0 ? stdout : undefined);
    });
  });

  if (output === undefined) {
    return undefined;
  }

  // `where` can report several matches, one per line. The first is the one a
  // shell would run.
  const first = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

  if (first === undefined) {
    return undefined;
  }

  const lowered = first.toLowerCase();
  return {
    path: first,
    isBatch: isWindows && (lowered.endsWith('.cmd') || lowered.endsWith('.bat')),
  };
}

/**
 * Checks whether an executable can be found on PATH.
 */
export async function isOnPath(command: string): Promise<boolean> {
  return (await resolveCommand(command)) !== undefined;
}

/** Give up on a command that never finishes, so listing models cannot hang. */
const CAPTURE_TIMEOUT_MS = 20 * 1000;

/**
 * Runs a command and collects its stdout. Returns undefined when the command is
 * missing, fails, or takes too long, so a caller can fall back rather than wait.
 */
export async function captureOutput(
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  const resolved = await resolveCommand(command);

  if (resolved === undefined) {
    return undefined;
  }

  const target = resolved.isBatch ? 'cmd.exe' : resolved.path;
  const finalArgs = resolved.isBatch ? ['/d', '/s', '/c', resolved.path, ...args] : [...args];

  return new Promise<string | undefined>((resolve) => {
    const child = spawn(target, finalArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: CAPTURE_TIMEOUT_MS,
    });

    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      resolve(undefined);
    });
    child.on('close', (code) => {
      resolve(code === 0 ? stdout : undefined);
    });
  });
}
