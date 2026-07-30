import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../dist/db/client.js';
import { runMigrations } from '../dist/db/migrate.js';
import type { DbHandle } from '../dist/db/client.js';

/**
 * Gives a test its own migrated database on disk.
 *
 * A file rather than :memory: because WAL mode, foreign keys, and migrations are
 * exactly what has to be verified, and none of that is meaningful without a real
 * file. Each test gets a fresh directory so tests cannot see each other's rows.
 */
export async function withTempDb<T>(
  run: (handle: DbHandle, file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-db-'));
  const file = join(dir, 'test.sqlite');
  const handle = openDb(file);

  runMigrations(handle.db);

  try {
    return await run(handle, file);
  } finally {
    handle.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Opens an existing database file again, standing in for a server restart. */
export async function reopenDb<T>(file: string, run: (handle: DbHandle) => Promise<T>): Promise<T> {
  const handle = openDb(file);
  runMigrations(handle.db);

  try {
    return await run(handle);
  } finally {
    handle.close();
  }
}
