import { readFile } from 'node:fs/promises';
import { ConfigError } from './error.js';
import { globalConfigPath } from './paths.js';
import { globalConfigSchema } from './schema.js';
import type { GlobalConfig } from './schema.js';

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
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

  const result = globalConfigSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(path, `Config is invalid: ${details}`);
  }

  return result.data;
}
