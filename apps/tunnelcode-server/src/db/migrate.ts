import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { copyFileSync, existsSync } from 'node:fs';
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

/**
 * Applies pending migrations. Runs at startup so a fresh deployment or an
 * upgraded image never serves requests against an out of date schema.
 *
 * A backup of the database is taken before any migration runs, so a bad upgrade
 * can be rolled back by replacing the file with its `.pre-migration` copy.
 */
export function runMigrations(db: Db, databaseFile: string): void {
  backupBeforeMigration(databaseFile);
  migrate(db, { migrationsFolder: join(import.meta.dirname, '..', '..', 'migrations') });
}
