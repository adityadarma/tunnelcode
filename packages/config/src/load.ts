import { readFile } from 'node:fs/promises';
import { ConfigError } from './error.js';
import { globalConfigPath } from './paths.js';
import { globalConfigSchema } from './schema.js';
import type { GlobalConfig } from './schema.js';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The name a pre-release build used for the engine, refused rather than ignored.
 *
 * `engine` is the only name the schema accepts, and it is now optional, so a file
 * naming the engine this instead would otherwise parse as one that chose nothing
 * and quietly start conversations on whatever is installed first. That is a stored
 * choice being dropped while the load reports success. Refusing sends the user to
 * Setup, which writes the file again under the name that is read. See ADR-019 and
 * ADR-056.
 *
 * Only this one name, because it is the only one a released build ever wrote. A
 * key nobody has been recorded writing is not guarded against on the strength of
 * it sounding plausible.
 */
const LEGACY_ENGINE_KEY = 'defaultEngine';

function hasLegacyEngineKey(value: unknown): boolean {
  return typeof value === 'object' && value !== null && LEGACY_ENGINE_KEY in value;
}

/**
 * Reads and validates the config file. Returns undefined when the file does not
 * exist, because a missing config is a normal state the CLI reports on its own.
 * Any other problem is an error the user must fix.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig | undefined> {
  const path = globalConfigPath();
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw new ConfigError(
      path,
      `Cannot read config: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(path, 'Config is not valid JSON.');
  }

  if (hasLegacyEngineKey(parsed)) {
    throw new ConfigError(
      path,
      `Config is invalid: ${LEGACY_ENGINE_KEY} is not read any more. The engine is named "engine". Choose it again from Setup.`,
    );
  }

  const result = globalConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(path, `Config is invalid: ${details}`);
  }

  return result.data;
}
