import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError } from './error.js';
import { globalConfigPath, workspaceConfigPath } from './paths.js';
import { globalConfigSchema, workspaceConfigSchema } from './schema.js';
import type { GlobalConfig, WorkspaceConfig } from './schema.js';

/**
 * Writes JSON to disk atomically: write a sibling temp file, then rename over
 * the target. A crash mid-write leaves the previous config intact instead of a
 * truncated file.
 */
async function writeJsonFile(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${String(process.pid)}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
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

export async function writeWorkspaceConfig(cwd: string, config: WorkspaceConfig): Promise<string> {
  const path = workspaceConfigPath(cwd);
  await writeJsonFile(path, workspaceConfigSchema.parse(config));
  return path;
}
