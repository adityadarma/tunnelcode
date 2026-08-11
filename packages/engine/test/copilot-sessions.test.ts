import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CopilotEngine } from '../dist/adapters/copilot.js';
import { SessionScanUnsupportedError } from '../dist/session.js';

/** The directory the fixture's sessions were held in. */
const CWD = '/work';

/**
 * Builds a session store the way the Copilot CLI builds its own: the same tables
 * in the same file under a home directory of its own, written by another process
 * and only ever read by the adapter.
 *
 * Turns are inserted out of order on purpose, so a title read from the lowest turn
 * index cannot pass by accident of insertion order.
 */
async function fixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'copilot-sessions-'));
  await mkdir(join(home, '.copilot'), { recursive: true });

  const write = new DatabaseSync(join(home, '.copilot', 'session-store.db'));
  write.exec(`
    create table sessions (
      id text primary key,
      cwd text,
      repository text,
      host_type text,
      branch text,
      summary text,
      created_at text,
      updated_at text
    )
  `);
  write.exec(`
    create table turns (
      id integer primary key autoincrement,
      session_id text not null references sessions(id),
      turn_index integer not null,
      user_message text,
      assistant_response text,
      timestamp text,
      unique(session_id, turn_index)
    )
  `);

  // Copilot leaves summary empty on every row, which is why the title comes from
  // the turns instead.
  write.exec(`
    insert into sessions (id, cwd, summary, created_at, updated_at) values
      ('defaulted', '/work', null, '2026-03-03 04:05:06', '2026-03-03 04:05:06'),
      ('newer', '/work', null, '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
      ('older', '/work', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('untouched', '/work', null, '2025-12-12T00:00:00.000Z', '2025-12-12T00:00:00.000Z'),
      ('elsewhere', '/other', null, '2026-04-04T00:00:00.000Z', '2026-04-04T00:00:00.000Z')
  `);
  write.exec(`
    insert into turns (session_id, turn_index, user_message, assistant_response) values
      ('newer', 1, 'the later question', 'the later answer'),
      ('newer', 0, 'the opening question', 'the opening answer'),
      ('older', 1, 'still waiting', ''),
      ('older', 0, 'first question', 'first answer'),
      ('defaulted', 0, 'written with a sqlite default timestamp', 'answered'),
      ('elsewhere', 0, 'another workspace', 'another answer')
  `);
  write.close();

  return home;
}

/**
 * Runs against a fixture home, since the adapter finds the store under it.
 *
 * Both variables are set because the home directory is named differently per
 * platform, and the real sessions on this machine are never touched either way.
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

test('lists the sessions held in a directory, newest first', async () => {
  const home = await fixture();

  try {
    const sessions = await withHome(home, () => new CopilotEngine().listLocalSessions(CWD));

    assert.deepEqual(
      sessions.map((session) => session.id),
      ['defaulted', 'newer', 'older', 'untouched'],
    );

    // A timestamp stored in SQLite's own default format is UTC spelled without
    // saying so, and is reported as the instant it means rather than moved by the
    // reader's offset.
    assert.equal(sessions[0]?.lastActiveAt, '2026-03-03T04:05:06.000Z');
    assert.equal(sessions[1]?.lastActiveAt, '2026-02-02T00:00:00.000Z');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('leaves out sessions held in another directory', async () => {
  const home = await fixture();

  try {
    const sessions = await withHome(home, () => new CopilotEngine().listLocalSessions(CWD));

    assert.equal(
      sessions.some((session) => session.id === 'elsewhere'),
      false,
    );
    assert.deepEqual(
      (await withHome(home, () => new CopilotEngine().listLocalSessions('/other'))).map(
        (session) => session.id,
      ),
      ['elsewhere'],
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('names a session after its opening question and previews its last answer', async () => {
  const home = await fixture();

  try {
    const sessions = await withHome(home, () => new CopilotEngine().listLocalSessions(CWD));
    const newer = sessions.find((session) => session.id === 'newer');
    const untouched = sessions.find((session) => session.id === 'untouched');

    assert.equal(newer?.title, 'the opening question');
    assert.equal(newer?.preview, 'the later answer');
    assert.equal(newer?.messageCount, 4);

    // A session Copilot opened and nobody asked anything in has no question to be
    // named after.
    assert.equal(untouched?.title, 'Untitled session');
    assert.equal(untouched?.messageCount, 0);
    assert.equal(untouched?.preview, '');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('counts and imports a turn that has no answer stored yet as the question alone', async () => {
  const home = await fixture();

  try {
    const engine = new CopilotEngine();
    const sessions = await withHome(home, () => engine.listLocalSessions(CWD));
    const content = await withHome(home, () => engine.readSessionContent('older', CWD));

    assert.equal(sessions.find((session) => session.id === 'older')?.messageCount, 3);
    assert.deepEqual(content.messages, [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'still waiting' },
    ]);
    assert.equal(content.engineSessionId, 'older');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reads the tool calls a session logged beside its store', async () => {
  const home = await fixture();
  const log = join(home, '.copilot', 'session-state', 'newer');
  await mkdir(log, { recursive: true });
  await writeFile(
    join(log, 'events.jsonl'),
    [
      JSON.stringify({ type: 'session.start', data: { sessionId: 'newer' } }),
      JSON.stringify({
        type: 'tool.execution_start',
        data: { toolCallId: 'call_1', toolName: 'view', arguments: { path: '/work/app.ts' } },
      }),
      JSON.stringify({
        type: 'tool.execution_complete',
        data: { toolCallId: 'call_1', success: true, result: { content: 'the file' } },
      }),
      JSON.stringify({
        type: 'tool.execution_start',
        data: { toolCallId: 'call_2', toolName: 'bash', arguments: { command: 'pnpm test' } },
      }),
      JSON.stringify({
        type: 'tool.execution_complete',
        data: { toolCallId: 'call_2', success: false, result: {} },
      }),
      '{"type":"tool.execution_start","data":{"toolCallId"',
    ].join('\n'),
  );

  try {
    const engine = new CopilotEngine();
    const withLog = await withHome(home, () => engine.readSessionContent('newer', CWD));
    // A session that used no tool has no log, which is no activities rather than a
    // failed import.
    const withoutLog = await withHome(home, () => engine.readSessionContent('older', CWD));

    assert.deepEqual(withLog.activities, [
      { id: 'call_1', tool: 'view', target: '/work/app.ts', output: 'the file' },
      { id: 'call_2', tool: 'bash', target: 'pnpm test', output: 'The tool call failed.' },
    ]);
    assert.deepEqual(withoutLog.activities, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reports a store that was never written as no history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'copilot-sessions-'));

  try {
    assert.deepEqual(await withHome(home, () => new CopilotEngine().listLocalSessions(CWD)), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('refuses to import a session the store does not hold here', async () => {
  const home = await fixture();

  try {
    const engine = new CopilotEngine();

    await assert.rejects(
      withHome(home, () => engine.readSessionContent('no-such-session', CWD)),
      /not found/i,
    );
    // An id held against another directory is not one this listing offered.
    await assert.rejects(
      withHome(home, () => engine.readSessionContent('elsewhere', CWD)),
      /not found/i,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('raises a store it cannot read rather than reporting an empty history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'copilot-sessions-'));
  await mkdir(join(home, '.copilot'), { recursive: true });
  await writeFile(
    join(home, '.copilot', 'session-store.db'),
    'this is not a database, it only has the name of one',
  );

  try {
    await assert.rejects(
      withHome(home, () => new CopilotEngine().listLocalSessions(CWD)),
      SessionScanUnsupportedError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
