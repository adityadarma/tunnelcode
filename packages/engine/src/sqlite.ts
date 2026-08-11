import { existsSync } from 'node:fs';
import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SessionScanUnsupportedError } from './session.js';

/**
 * How long SQLite waits for another process to release a lock before it gives
 * up. The databases read here belong to running agents, so a short wait is
 * usually enough to get past a write in progress.
 */
const BUSY_TIMEOUT_MS = 2000;

/**
 * A database opened for reading, narrowed to what a session scan needs.
 *
 * Rows come back as whatever the query selected, so `T` is the caller's claim
 * about the columns rather than a checked fact: nothing here validates the
 * shape. Keep the type next to the SQL that produces it.
 */
export interface ReadonlyDatabase {
  /**
   * Runs a query and returns every row.
   *
   * Throws SessionScanUnsupportedError when SQLite refuses the read, which is
   * where a corrupt file or a lock held past the busy timeout shows up: SQLite
   * only touches pages when a statement runs, so a database that opened fine
   * can still fail here.
   */
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  /** Releases the file. Safe to call once, in a finally block. */
  close(): void;
}

/**
 * Opens a SQLite database owned by another program, for reading only.
 *
 * Returns undefined when the file does not exist, which is the normal state of
 * an engine that has not stored a session yet: absence of history is not a
 * failure, and the caller reports no sessions rather than an error.
 *
 * Throws SessionScanUnsupportedError when the read cannot happen: either this
 * Node build has no SQLite, or the file exists and SQLite refuses it because
 * another process holds it past the busy timeout, its contents are not a
 * database, or this user cannot read it. Every one of those is a reason the
 * engine cannot be scanned here, and the caller reports it as such instead of
 * as an empty history. Queries fail the same way, so a caller only has one
 * error type to handle.
 */
export async function openSqliteReadonly(path: string): Promise<ReadonlyDatabase | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }

  const { DatabaseSync: Database } = await loadSqlite();

  let database: DatabaseSync;
  try {
    database = new Database(path, { open: true, readOnly: true, timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    throw new SessionScanUnsupportedError(`Could not read ${path}: ${describe(error)}`);
  }

  return {
    all<T>(sql: string, ...params: SQLInputValue[]): T[] {
      try {
        return database.prepare(sql).all(...params) as T[];
      } catch (error) {
        throw new SessionScanUnsupportedError(`Could not read ${path}: ${describe(error)}`);
      }
    },
    close(): void {
      database.close();
    },
  };
}

/**
 * Loads node:sqlite at call time.
 *
 * The import is deferred because it throws outright on a Node build without
 * SQLite, and importing this file must never take the whole engine package down
 * with it: an engine that reads a database is one of several, and the others
 * still work.
 */
async function loadSqlite(): Promise<typeof NodeSqlite> {
  try {
    return await import('node:sqlite');
  } catch {
    // Unflagged from Node 23.4 on. Before that the module only exists behind
    // --experimental-sqlite, so the import fails on an otherwise fine Node 22.
    throw new SessionScanUnsupportedError("Reading this engine's sessions needs Node 24 or newer.");
  }
}

/** The message SQLite gave, without the stack a user has no use for. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
