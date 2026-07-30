import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import type { Db } from './client.js';

/**
 * Applies pending migrations. Runs at startup so a fresh deployment or an
 * upgraded image never serves requests against an out of date schema.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: join(import.meta.dirname, '..', '..', 'migrations') });
}
