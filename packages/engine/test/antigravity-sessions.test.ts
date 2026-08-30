import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AntigravityEngine } from '../dist/adapters/antigravity.js';
import { SessionScanUnsupportedError } from '../dist/session.js';

/** The directory the fixture's conversations were held in. */
const CWD = '/work';

/** The same directory as Antigravity stores it: a JSON array of `file://` URIs. */
const HERE = JSON.stringify([pathToFileURL(CWD).href]);
const ELSEWHERE = JSON.stringify([pathToFileURL('/other').href]);

interface Row {
  id: string;
  title?: string | null;
  preview?: string | null;
  steps?: number | null;
  time?: string | null;
  workspaces?: string | null;
}

/**
 * Builds the summary store the way Antigravity builds its own: the same table in
 * the same file under a home directory of its own, written by another process and
 * only ever read by the adapter.
 *
 * Rows are inserted out of order on purpose, so an ordering the adapter is meant
 * to impose cannot pass by accident on insertion order.
 */
async function fixture(rows: readonly Row[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'antigravity-sessions-'));
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });

  const write = new DatabaseSync(
    join(home, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
  );

  write.exec(`
    create table conversation_summaries (
      conversation_id text primary key,
      title text,
      preview text,
      step_count integer,
      last_modified_time text,
      workspace_uris text
    )
  `);

  const insert = write.prepare(`
    insert into conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, workspace_uris)
    values (?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    insert.run(
      row.id,
      row.title ?? null,
      row.preview ?? null,
      row.steps ?? null,
      row.time ?? null,
      // An explicit null is a row with no workspaces, which is not the same as a
      // row that simply did not say and gets the fixture's own directory.
      row.workspaces === undefined ? HERE : row.workspaces,
    );
  }

  write.close();

  return home;
}

/**
 * Runs with the home directory pointed at the fixture.
 *
 * Both variables are set because the home directory is named differently per
 * platform, and real conversations on this machine are never touched either way.
 */
async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const restore = (
    [
      ['HOME', home],
      ['USERPROFILE', home],
    ] as const
  ).map(([name, value]) => {
    const previous = process.env[name];
    process.env[name] = value;

    return (): void => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    };
  });

  try {
    return await run();
  } finally {
    for (const undo of restore) {
      undo();
    }
  }
}

async function listIn(rows: readonly Row[], cwd = CWD) {
  const home = await fixture(rows);

  try {
    return await withHome(home, () => new AntigravityEngine().listLocalSessions(cwd));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('lists the conversations held in a directory, newest first', async () => {
  const sessions = await listIn([
    { id: 'older', preview: 'Older work', time: '2026-01-01T00:00:00+00:00' },
    { id: 'newer', preview: 'Newer work', time: '2026-03-03T04:05:06+00:00' },
    { id: 'middle', preview: 'Middle work', time: '2026-02-02T00:00:00+00:00' },
  ]);

  assert.deepEqual(
    sessions.map((session) => session.id),
    ['newer', 'middle', 'older'],
  );

  // Antigravity writes an explicit offset, so the instant is reported as the one
  // it means rather than moved by the reader's own offset.
  assert.equal(sessions[0]?.lastActiveAt, '2026-03-03T04:05:06.000Z');
});

test('leaves out conversations held in another directory', async () => {
  const sessions = await listIn([
    { id: 'here', preview: 'Here', time: '2026-01-01T00:00:00+00:00' },
    { id: 'there', preview: 'There', time: '2026-02-01T00:00:00+00:00', workspaces: ELSEWHERE },
  ]);

  assert.deepEqual(
    sessions.map((session) => session.id),
    ['here'],
  );
});

test('matches a workspace listed beside others', async () => {
  const both = JSON.stringify([pathToFileURL('/other').href, pathToFileURL(CWD).href]);
  const sessions = await listIn([{ id: 'both', preview: 'Both', workspaces: both }]);

  assert.deepEqual(
    sessions.map((session) => session.id),
    ['both'],
  );
});

test('leaves out a conversation whose workspaces cannot be read', async () => {
  const sessions = await listIn([
    { id: 'unparseable', preview: 'Broken', workspaces: 'not json' },
    { id: 'not-an-array', preview: 'Wrong shape', workspaces: '{"path":"/work"}' },
    { id: 'not-a-uri', preview: 'Plain path', workspaces: JSON.stringify(['/work']) },
    { id: 'missing', preview: 'No column', workspaces: null },
  ]);

  assert.deepEqual(sessions, []);
});

test('falls back to the preview, then to a placeholder, for a title', async () => {
  const sessions = await listIn([
    { id: 'titled', title: 'Real title', preview: 'Ignored preview' },
    { id: 'previewed', title: '', preview: 'Preview stands in' },
    { id: 'blank', title: '   ', preview: '  ' },
    { id: 'absent' },
  ]);

  const titles = new Map(sessions.map((session) => [session.id, session.title]));

  assert.equal(titles.get('titled'), 'Real title');
  assert.equal(titles.get('previewed'), 'Preview stands in');
  assert.equal(titles.get('blank'), 'Untitled session');
  assert.equal(titles.get('absent'), 'Untitled session');
});

test('reads a step count, and counts an unreadable one as none', async () => {
  const sessions = await listIn([
    { id: 'counted', preview: 'Counted', steps: 12 },
    { id: 'uncounted', preview: 'Uncounted' },
    { id: 'negative', preview: 'Negative', steps: -3 },
  ]);

  const counts = new Map(sessions.map((session) => [session.id, session.messageCount]));

  assert.equal(counts.get('counted'), 12);
  assert.equal(counts.get('uncounted'), 0);
  assert.equal(counts.get('negative'), 0);
});

test('keeps a conversation whose stored time cannot be read, sorted last', async () => {
  const sessions = await listIn([
    { id: 'timed', preview: 'Timed', time: '2026-01-01T00:00:00+00:00' },
    { id: 'untimed', preview: 'Untimed', time: 'whenever' },
    { id: 'missing-time', preview: 'No time' },
  ]);

  const times = new Map(sessions.map((session) => [session.id, session.lastActiveAt]));

  assert.equal(times.get('timed'), '2026-01-01T00:00:00.000Z');
  assert.equal(times.get('untimed'), new Date(0).toISOString());
  assert.equal(times.get('missing-time'), new Date(0).toISOString());
});

test('offers at most fifty conversations', async () => {
  const rows: Row[] = Array.from({ length: 60 }, (_, index) => ({
    id: `session-${String(index).padStart(2, '0')}`,
    preview: `Work ${String(index)}`,
    // Counting down, so the newest row is the one inserted first and the cap
    // cannot be satisfied by insertion order alone.
    time: `2026-01-01T00:00:${String(59 - index).padStart(2, '0')}+00:00`,
  }));

  const sessions = await listIn(rows);

  assert.equal(sessions.length, 50);
  assert.equal(sessions[0]?.id, 'session-00');
});

test('reports no history when Antigravity has never run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'antigravity-empty-'));

  try {
    const sessions = await withHome(home, () => new AntigravityEngine().listLocalSessions(CWD));

    assert.deepEqual(sessions, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reports that a conversation cannot be read', async () => {
  await assert.rejects(
    () => new AntigravityEngine().readSessionContent(),
    (error: unknown) => error instanceof SessionScanUnsupportedError,
  );
});
