import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteReadonly } from '../dist/sqlite.js';
import { SessionScanUnsupportedError } from '../dist/session.js';

/**
 * Builds a database on disk the way the engines being read build theirs: an
 * ordinary file another process owns, which the helper only ever reads.
 */
async function fixture(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-sqlite-'));
  const path = join(dir, 'sessions.db');
  const write = new DatabaseSync(path);
  write.exec('create table sessions (id text primary key, cwd text, updated_at text)');
  write.exec(
    "insert into sessions values ('a', '/tmp/one', '2026-01-01T00:00:00Z'), ('b', '/tmp/two', '2026-01-02T00:00:00Z')",
  );
  write.close();
  return { dir, path };
}

test('reads rows from a database another program owns', async () => {
  const { dir, path } = await fixture();

  try {
    const database = await openSqliteReadonly(path);
    assert.ok(database !== undefined);

    const rows = database.all<{ id: string; cwd: string }>(
      'select id, cwd from sessions order by updated_at desc',
    );
    database.close();

    // Rows arrive with a null prototype, so they are spread before comparing.
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { id: 'b', cwd: '/tmp/two' },
        { id: 'a', cwd: '/tmp/one' },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('binds parameters rather than pasting them into the SQL', async () => {
  const { dir, path } = await fixture();

  try {
    const database = await openSqliteReadonly(path);
    assert.ok(database !== undefined);

    const rows = database.all<{ cwd: string }>('select cwd from sessions where id = ?', 'a');
    database.close();

    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ cwd: '/tmp/one' }],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses to write through a database it opened', async () => {
  const { dir, path } = await fixture();

  try {
    const database = await openSqliteReadonly(path);
    assert.ok(database !== undefined);

    assert.throws(() => database.all("insert into sessions values ('c', '/tmp/three', 'now')"), {
      message: /readonly/,
    });
    database.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports a missing file as no history rather than as a failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-sqlite-'));

  try {
    assert.equal(await openSqliteReadonly(join(dir, 'never-written.db')), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not create the file it was asked to read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-sqlite-'));
  const path = join(dir, 'never-written.db');

  try {
    await openSqliteReadonly(path);
    assert.equal(existsSync(path), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports a file that is not a database as unsupported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-sqlite-'));
  const path = join(dir, 'sessions.db');
  await writeFile(path, 'this is not a database, it only has the name of one');

  try {
    // SQLite only notices when a statement reads a page, so the open can
    // succeed and the query is where it fails. Either way the caller sees one
    // error type.
    const database = await openSqliteReadonly(path);
    assert.throws(() => database?.all('select 1 from sessions'), SessionScanUnsupportedError);
  } catch (error) {
    assert.ok(error instanceof SessionScanUnsupportedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
