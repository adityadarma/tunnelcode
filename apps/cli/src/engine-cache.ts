import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { enginesCachePath } from '@tunnelcode/config';
import { findInstalledEngines } from '@tunnelcode/engine';
import type { AvailableEngine, InstalledEngine } from '@tunnelcode/engine';
import { readVersion } from './version.js';

/**
 * Model lists remembered between runs, so starting a session is not spent waiting
 * for engines to introduce themselves again.
 *
 * Only the expensive half of discovery is cached. Whether an engine is installed is
 * a `which` and is asked every time, so installing or removing one shows up on the
 * next start; what it can answer with runs the engine's own CLI, which on a normal
 * machine costs several seconds and reports the same list every time. See ADR-053.
 */

/** Bumped when the shape below changes, so an older file is discarded rather than read. */
const CACHE_VERSION = 1;

/**
 * How long a remembered model list is trusted.
 *
 * Long enough that a day of work never waits for discovery, short enough that a model
 * an engine gained is not hidden for a week. Nothing here is load-bearing: a stale
 * list costs a model that could have been picked, not a session that cannot run.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

const cacheFileSchema = z.object({
  version: z.literal(CACHE_VERSION),
  /**
   * CLI version that wrote this. A different one means adapters may parse the same
   * engine output differently, so the lists are re-read rather than trusted.
   */
  cliVersion: z.string(),
  engines: z.array(
    z.object({
      name: z.string(),
      /**
       * Path-resolved command the models were read from. An engine reinstalled
       * somewhere else is a different program, so its old list does not carry over.
       */
      command: z.string(),
      at: z.number(),
      models: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  ),
});

type CacheFile = z.infer<typeof cacheFileSchema>;
type CacheEntry = CacheFile['engines'][number];

/**
 * Reads the cache, or nothing when it is missing, unreadable or written by another
 * version. Every failure is the same answer here: ask the engines.
 */
async function readCache(): Promise<CacheEntry[]> {
  let raw: string;

  try {
    raw = await readFile(enginesCachePath(), 'utf8');
  } catch {
    return [];
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }

  const parsed = cacheFileSchema.safeParse(value);

  if (!parsed.success || parsed.data.cliVersion !== readVersion()) {
    return [];
  }

  return parsed.data.engines;
}

/** Writes the cache, and says nothing when it cannot: this is a shortcut, not state. */
async function writeCache(engines: CacheEntry[]): Promise<void> {
  const path = enginesCachePath();
  const file: CacheFile = { version: CACHE_VERSION, cliVersion: readVersion(), engines };

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  } catch {
    // A cache that cannot be written is a slower start next time, nothing more.
  }
}

/**
 * The same list `discoverEngines` returns, with the slow half read from disk when it
 * is still fresh.
 *
 * An engine whose entry is missing, stale, or was recorded against a different
 * executable is asked directly, so a machine that has never run this only pays the
 * wait once. The engines that are asked are asked in parallel, as before.
 */
export async function discoverEnginesCached(): Promise<AvailableEngine[]> {
  const [installed, cached] = await Promise.all([findInstalledEngines(), readCache()]);
  const now = Date.now();

  const fresh = (entry: InstalledEngine): CacheEntry | undefined =>
    cached.find(
      (row) =>
        row.name === entry.name && row.command === entry.command && now - row.at < CACHE_TTL_MS,
    );

  const results = await Promise.all(
    installed.map(async (entry): Promise<{ available: AvailableEngine; row: CacheEntry }> => {
      const known = fresh(entry);
      const models = known?.models ?? (await entry.engine.listModels());

      return {
        available: { name: entry.name, label: entry.label, command: entry.command, models },
        // A cache hit keeps its own timestamp, so a list is re-read once the window
        // passes rather than being renewed by every start that read it.
        row: known ?? { name: entry.name, command: entry.command, at: now, models },
      };
    }),
  );

  await writeCache(results.map((result) => result.row));

  return results.map((result) => result.available);
}
