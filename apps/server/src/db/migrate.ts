import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { sql } from 'drizzle-orm';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './client.js';

/**
 * Backs up the database file before applying pending migrations.
 *
 * A lightweight safety net: if a migration corrupts data or is later found to be
 * wrong, the previous state is one file copy away. Only taken when the file
 * exists and is not an in-memory test database.
 *
 * The backup sits beside the database with a `.pre-migration` suffix. A second
 * upgrade overwrites the previous backup, which is intentional: the one worth
 * keeping is the last state before the latest schema change, not every state the
 * database has ever been in.
 */
function backupBeforeMigration(databaseFile: string): void {
  if (databaseFile === ':memory:' || !existsSync(databaseFile)) {
    return;
  }

  const backupPath = `${databaseFile}.pre-migration`;
  copyFileSync(databaseFile, backupPath);
}

/** How many migrations the folder claims to have. */
function countInJournal(folder: string): number {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries?: unknown;
  };

  return Array.isArray(journal.entries) ? journal.entries.length : 0;
}

/** How many the database says it has run. */
function countApplied(db: Db): number {
  const rows = db.all<{ applied: number }>(
    sql`select count(*) as applied from "__drizzle_migrations"`,
  );

  return rows[0]?.applied ?? 0;
}

/**
 * Applies pending migrations. Runs at startup so a fresh deployment or an
 * upgraded image never serves requests against an out of date schema.
 *
 * A backup of the database is taken before any migration runs, so a bad upgrade
 * can be rolled back by replacing the file with its `.pre-migration` copy.
 *
 * The count is checked afterwards because a migration can be passed over in
 * silence. The migrator applies a migration only when its journal timestamp is
 * later than the newest one the database has recorded, so one written by hand with
 * a stamp ahead of the clock makes every migration generated after it — but stamped
 * before it — invisible. That is not a crash: the server starts, and the first
 * request touching the missing column answers 500. Failing here instead says which
 * migration never ran, while the schema is still the only thing that is wrong.
 */
export function runMigrations(db: Db, databaseFile: string): void {
  backupBeforeMigration(databaseFile);

  const folder = join(import.meta.dirname, '..', '..', 'migrations');

  migrate(db, { migrationsFolder: folder });

  const expected = countInJournal(folder);
  const applied = countApplied(db);

  if (applied < expected) {
    throw new Error(
      `Only ${String(applied)} of ${String(expected)} migrations were applied. A migration whose journal timestamp is older than one already applied is skipped without warning; check the "when" values in migrations/meta/_journal.json.`,
    );
  }
}
