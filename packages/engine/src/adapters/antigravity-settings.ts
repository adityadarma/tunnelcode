import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isRecord } from '@tunnelcode/shared';

/**
 * Antigravity's own settings file.
 *
 * This belongs to `agy`, not to this project, and it is read every time `agy` runs
 * rather than only when this project runs it. Anything written here changes the
 * user's own terminal sessions too, which is why nothing is written without them
 * asking for it. See ADR-031.
 */
export function antigravitySettingsPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
}

/** Mode used only for a file that does not exist yet. */
const OWNER_ONLY_FILE = 0o600;

/**
 * Raised when the settings file cannot be read as JSON.
 *
 * Refusing is the point: overwriting a file this project does not own, and whose
 * current contents it cannot understand, would destroy settings nobody asked it to
 * touch.
 */
export class AntigravitySettingsError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'AntigravitySettingsError';
    this.path = path;
  }
}

/**
 * The rule that lets Antigravity write in a workspace.
 *
 * Symlinks are resolved because Antigravity judges the rule against the real path:
 * a workspace reached through `/tmp` on macOS is refused as `/private/tmp/...`, so a
 * rule naming the link would never match.
 *
 * `write_file` alone is enough. It implicitly grants `read_file` on the same target,
 * and reading inside a workspace is allowed without any rule, so this is the
 * narrowest grant that makes the engine able to work.
 */
export async function workspaceWriteRule(cwd: string): Promise<string> {
  let resolved = cwd;

  try {
    resolved = await realpath(cwd);
  } catch {
    // A path that cannot be resolved is used as given, which is still the best
    // guess available and fails visibly rather than silently.
  }

  return `write_file(${resolved})`;
}

/**
 * The rule that lets Antigravity run commands.
 *
 * Every command, because Antigravity matches a command rule as a prefix of the
 * whole command line. The agent writes its own command lines and puts its own
 * prefix in front of them, so `command(flutter)` still refuses
 * `cd <workspace> && flutter analyze`. A narrower rule would therefore read as a
 * limit it does not deliver, while leaving the work refused most of the time.
 *
 * Not scoped to a workspace either, because a command rule has no path to scope
 * to. This is the one grant in this project that is wider than the work in front
 * of it, which is why it is asked for on its own and never implied by another.
 */
export const RUN_COMMANDS_RULE = 'command(*)';

/** Reads the settings, or undefined when there is no file yet. */
async function readSettings(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  if (raw.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AntigravitySettingsError(
      path,
      'Antigravity settings are not valid JSON. Fix or remove the file, then try again.',
    );
  }

  if (!isRecord(parsed)) {
    throw new AntigravitySettingsError(path, 'Antigravity settings are not a JSON object.');
  }

  return parsed;
}

/**
 * Writes the settings back atomically, keeping the mode the file already had.
 *
 * A temp file and a rename, so a crash leaves Antigravity's settings as they were
 * rather than truncated. The existing mode is kept rather than replaced: this file
 * is another tool's, and tightening or loosening it is not this project's decision.
 */
async function writeSettings(path: string, value: Record<string, unknown>): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.tunnelcode.${String(process.pid)}.tmp`);

  let mode = OWNER_ONLY_FILE;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // No file yet, so the restrictive default stands. It records what the agent may
    // do on this machine, which is not something to leave world-readable.
  }

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode,
    });
    await rename(temporary, path);
    // Again after the rename, because a mode given at creation does not apply to a
    // path that already existed.
    await chmod(path, mode);
  } catch (error) {
    throw new AntigravitySettingsError(
      path,
      `Cannot write Antigravity settings: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** The allow list as it stands, with anything unreadable treated as empty. */
function readAllowList(settings: Record<string, unknown>): string[] {
  const permissions = settings['permissions'];

  if (!isRecord(permissions)) {
    return [];
  }

  const allow = permissions['allow'];

  return Array.isArray(allow)
    ? allow.filter((rule): rule is string => typeof rule === 'string')
    : [];
}

/**
 * Puts an allow list back, leaving every other setting exactly as it was.
 *
 * Only `permissions.allow` is touched. `deny` and `ask` decide what the user has
 * already refused, and the rest of the file is theirs.
 */
function withAllowList(
  settings: Record<string, unknown>,
  allow: readonly string[],
): Record<string, unknown> {
  const permissions = isRecord(settings['permissions']) ? settings['permissions'] : {};

  return {
    ...settings,
    permissions: { ...permissions, allow: [...allow] },
  };
}

/** Whether one rule is already in the allow list. */
async function isAllowed(rule: string): Promise<boolean> {
  let settings: Record<string, unknown> | undefined;

  try {
    settings = await readSettings(antigravitySettingsPath());
  } catch {
    // Reported as not granted rather than thrown, so a broken file cannot stop the
    // menu from being drawn. Granting it is what surfaces the error.
    return false;
  }

  return settings !== undefined && readAllowList(settings).includes(rule);
}

/**
 * Adds one rule to the allow list.
 *
 * Returns false when it was already there, so the caller can say what it did
 * rather than claiming a change it did not make.
 */
async function allow(rule: string): Promise<boolean> {
  const path = antigravitySettingsPath();
  const settings = (await readSettings(path)) ?? {};
  const rules = readAllowList(settings);

  if (rules.includes(rule)) {
    return false;
  }

  await writeSettings(path, withAllowList(settings, [...rules, rule]));
  return true;
}

/** Takes one rule back out, leaving every rule the user added themselves alone. */
async function revoke(rule: string): Promise<boolean> {
  const path = antigravitySettingsPath();
  const settings = await readSettings(path);

  if (settings === undefined) {
    return false;
  }

  const rules = readAllowList(settings);

  if (!rules.includes(rule)) {
    return false;
  }

  await writeSettings(
    path,
    withAllowList(
      settings,
      rules.filter((entry) => entry !== rule),
    ),
  );

  return true;
}

/** Whether Antigravity may already write in a workspace. */
export async function isWorkspaceWritable(cwd: string): Promise<boolean> {
  return isAllowed(await workspaceWriteRule(cwd));
}

/** Grants Antigravity write access to one workspace. */
export async function allowWorkspaceWrites(cwd: string): Promise<boolean> {
  return allow(await workspaceWriteRule(cwd));
}

/** Takes that grant back. */
export async function revokeWorkspaceWrites(cwd: string): Promise<boolean> {
  return revoke(await workspaceWriteRule(cwd));
}

/** Whether Antigravity may already run commands. */
export async function areCommandsAllowed(): Promise<boolean> {
  return isAllowed(RUN_COMMANDS_RULE);
}

/** Grants Antigravity permission to run commands. */
export async function allowCommands(): Promise<boolean> {
  return allow(RUN_COMMANDS_RULE);
}

/** Takes that grant back. */
export async function revokeCommands(): Promise<boolean> {
  return revoke(RUN_COMMANDS_RULE);
}
