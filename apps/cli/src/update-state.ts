import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Reads a JSON file, returning undefined for anything that stops it being
 * read back: missing file, invalid JSON, whatever. Callers validate shape
 * themselves, so every failure collapses to the same "nothing here" result.
 */
export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes JSON to disk, saying nothing when it fails. Used for state a process
 * discovered rather than something a user asked to save, so a write that
 * cannot land costs nothing beyond having to discover it again next time.
 */
export async function writeJsonFileQuiet(path: string, value: unknown): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {
    // Best effort only.
  }
}
