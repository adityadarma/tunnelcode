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
 * Give up on listing an engine's models, so discovery cannot hang forever.
 *
 * Listing runs in the background rather than in front of the pairing code, so
 * this no longer has to be short enough to keep off screen — it has to be long
 * enough for the slowest engine to actually answer. An ACP-based engine such as
 * Cursor or Copilot spawns a process and completes a handshake before it can
 * report anything, which measured at 5-8 seconds on an ordinary machine; a flat
 * 5 second budget cut that off and reported it with no models rather than the
 * ones it has. 15 seconds covers that with room to spare, without leaving a
 * genuinely stuck process running indefinitely.
 */
export const MODEL_LIST_TIMEOUT_MS = 15 * 1000;

/**
 * Runs a command and collects its stdout. Returns undefined when the command is
 * missing, fails, or takes too long, so a caller can fall back rather than wait.
 */
export async function captureOutput(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number | undefined } = {},
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
      timeout: options.timeoutMs ?? CAPTURE_TIMEOUT_MS,
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
