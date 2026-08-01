import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError } from './error.js';
import { globalConfigPath } from './paths.js';
import { globalConfigSchema } from './schema.js';
import type { GlobalConfig } from './schema.js';

/**
 * Writes JSON to disk atomically: write a sibling temp file, then rename over
 * the target. A crash mid-write leaves the previous config intact instead of a
 * truncated file.
 *
 * Readable only by its owner. What is written here says which server this machine
 * answers to and which tool calls it has agreed to make without asking again, so
 * on a shared machine the umask default of world-readable was a list of what could
 * be done to this account, handed to everyone with an account of their own. The
 * mode is set on the temp file, which the rename carries over, so the target is
 * never briefly readable. See ADR-029.
 */
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIRECTORY = 0o700;

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${String(process.pid)}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
    await writeFile(temporary, content, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
    await rename(temporary, path);
    // Set again after the rename, because mode only applies to a file being
    // created: overwriting one that already exists would otherwise keep whatever
    // mode it was first written with.
    await chmod(path, OWNER_ONLY_FILE);
  } catch (error) {
    throw new ConfigError(
      path,
      `Cannot write config: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<string> {
  const path = globalConfigPath();
  await writeJsonFile(path, globalConfigSchema.parse(config));
  return path;
}
