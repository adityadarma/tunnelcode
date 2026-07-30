import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  close(): void;
}

/**
 * Opens the SQLite database.
 *
 * WAL is enabled because the server reads history while writing new messages,
 * and foreign keys are turned on explicitly since SQLite leaves them off by
 * default, which would let cascade deletes silently do nothing.
 */
export function openDb(file: string): DbHandle {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  return {
    db: drizzle(sqlite, { schema }),
    close: () => {
      sqlite.close();
    },
  };
}
