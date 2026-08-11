import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenCodeEngine } from '../dist/adapters/opencode.js';
import { SessionScanUnsupportedError } from '../dist/session.js';

const WORKSPACE = '/Users/someone/project';

/**
 * A session as opencode stores one, with only the columns this adapter reads.
 *
 * `timeUpdated` is epoch milliseconds because that is what the real database
 * holds: the session recorded on the machine this was written against carries
 * `1786264956645` for `2026-08-09T08:42:36.645Z`.
 */
interface SeedSession {
  id: string;
  directory: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  messages?: SeedMessage[];
}

interface SeedMessage {
  id: string;
  role: string;
  timeCreated: number;
  /** Part payloads, exactly as opencode writes them into `part.data`. */
  parts: Record<string, unknown>[];
}

/**
 * Builds a database with opencode's schema, the way opencode builds its own.
 *
 * The columns and indexes are copied from the live store rather than invented, so
 * a query that works here works there: `time_created` and `time_updated` are
 * integers, and the role of a message and the type of a part are both fields
 * inside a JSON column.
 */
function seed(path: string, sessions: SeedSession[]): void {
  const write = new DatabaseSync(path);

  write.exec(`create table session (
    id text primary key,
    project_id text not null,
    parent_id text,
    slug text not null,
    directory text not null,
    title text not null,
    time_created integer not null,
    time_updated integer not null
  )`);
  write.exec(`create table message (
    id text primary key,
    session_id text not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null
  )`);
  write.exec(`create table part (
    id text primary key,
    message_id text not null,
    session_id text not null,
    time_created integer not null,
    time_updated integer not null,
    data text not null
  )`);
  write.exec(
    'create index message_session_time_created_id_idx on message (session_id, time_created, id)',
  );
  write.exec('create index part_message_id_id_idx on part (message_id, id)');

  const addSession = write.prepare('insert into session values (?, ?, null, ?, ?, ?, ?, ?)');
  const addMessage = write.prepare('insert into message values (?, ?, ?, ?, ?)');
  const addPart = write.prepare('insert into part values (?, ?, ?, ?, ?, ?)');

  // Part ids are unique across the whole store, and their order within a message
  // is what opencode replays a conversation by, so one counter serves both.
  let partOrder = 0;

  for (const session of sessions) {
    addSession.run(
      session.id,
      'prj_1',
      'slug',
      session.directory,
      session.title,
      session.timeCreated,
      session.timeUpdated,
    );

    for (const message of session.messages ?? []) {
      addMessage.run(
        message.id,
        session.id,
        message.timeCreated,
        message.timeCreated,
        JSON.stringify({ role: message.role, path: { cwd: session.directory } }),
      );

      for (const part of message.parts) {
        partOrder += 1;
        addPart.run(
          `prt_${String(partOrder).padStart(4, '0')}`,
          message.id,
          session.id,
          message.timeCreated + partOrder,
          message.timeCreated + partOrder,
          JSON.stringify(part),
        );
      }
    }
  }

  write.close();
}

/**
 * Runs against an isolated data directory, so no test reads the developer's own
 * opencode history or is affected by what is in it.
 */
async function withStore<T>(
  run: (store: { db: string; engine: OpenCodeEngine }) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-opencode-home-'));
  const data = join(home, '.local', 'share');
  await mkdir(join(data, 'opencode'), { recursive: true });

  // XDG_DATA_HOME is what opencode itself honours; HOME covers the default it
  // falls back to, so the path is isolated either way.
  const restore = (
    [
      ['HOME', home],
      ['USERPROFILE', home],
      ['XDG_DATA_HOME', data],
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
    return await run({ db: join(data, 'opencode', 'opencode.db'), engine: new OpenCodeEngine() });
  } finally {
    for (const undo of restore) {
      undo();
    }

    await rm(home, { recursive: true, force: true });
  }
}

test('lists the sessions of one directory, most recently active first', async () => {
  await withStore(async ({ db, engine }) => {
    seed(db, [
      {
        id: 'ses_older',
        directory: WORKSPACE,
        title: 'Older work',
        timeCreated: 1786000000000,
        timeUpdated: 1786100000000,
        messages: [
          { id: 'msg_1', role: 'user', timeCreated: 1786000000000, parts: [text('hello')] },
          { id: 'msg_2', role: 'assistant', timeCreated: 1786000001000, parts: [text('hi')] },
        ],
      },
      {
        id: 'ses_newer',
        directory: WORKSPACE,
        title: 'Newer work',
        timeCreated: 1786200000000,
        timeUpdated: 1786264956645,
        messages: [
          { id: 'msg_3', role: 'user', timeCreated: 1786200000000, parts: [text('check this')] },
          {
            id: 'msg_4',
            role: 'assistant',
            timeCreated: 1786200001000,
            parts: [text('an earlier answer')],
          },
          {
            id: 'msg_5',
            role: 'assistant',
            timeCreated: 1786200002000,
            parts: [text('the last answer')],
          },
        ],
      },
    ]);

    const sessions = await engine.listLocalSessions(WORKSPACE);

    assert.deepEqual(
      sessions.map((session) => session.id),
      ['ses_newer', 'ses_older'],
    );
    // Epoch milliseconds read as a date rather than as a number.
    assert.equal(sessions[0]?.lastActiveAt, '2026-08-09T08:42:36.645Z');
    assert.equal(sessions[0]?.title, 'Newer work');
    assert.equal(sessions[0]?.messageCount, 3);
    // The last thing the assistant said, not the first.
    assert.equal(sessions[0]?.preview, 'the last answer');
    assert.equal(sessions[1]?.messageCount, 2);
  });
});

test('leaves out the sessions of other directories', async () => {
  await withStore(async ({ db, engine }) => {
    seed(db, [
      {
        id: 'ses_here',
        directory: WORKSPACE,
        title: 'Here',
        timeCreated: 1786000000000,
        timeUpdated: 1786000000000,
      },
      {
        id: 'ses_elsewhere',
        directory: '/Users/someone/other',
        title: 'Elsewhere',
        timeCreated: 1786100000000,
        timeUpdated: 1786100000000,
      },
    ]);

    assert.deepEqual(
      (await engine.listLocalSessions(WORKSPACE)).map((session) => session.id),
      ['ses_here'],
    );
    assert.deepEqual(await engine.listLocalSessions('/Users/someone/untouched'), []);
  });
});

test('stands the first user message in for a session opencode never titled', async () => {
  await withStore(async ({ db, engine }) => {
    seed(db, [
      {
        id: 'ses_untitled',
        directory: WORKSPACE,
        title: '',
        timeCreated: 1786000000000,
        timeUpdated: 1786000002000,
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            timeCreated: 1786000000000,
            parts: [{ type: 'step-start' }],
          },
          {
            id: 'msg_2',
            role: 'user',
            timeCreated: 1786000001000,
            parts: [text('the question that was asked first')],
          },
          { id: 'msg_3', role: 'user', timeCreated: 1786000002000, parts: [text('and then this')] },
        ],
      },
      {
        id: 'ses_silent',
        directory: WORKSPACE,
        title: '   ',
        timeCreated: 1785000000000,
        timeUpdated: 1785000000000,
        messages: [
          {
            id: 'msg_4',
            role: 'assistant',
            timeCreated: 1785000000000,
            parts: [{ type: 'step-finish', tokens: { input: 1 } }],
          },
        ],
      },
    ]);

    const sessions = await engine.listLocalSessions(WORKSPACE);

    assert.equal(sessions[0]?.title, 'the question that was asked first');
    // Nothing was ever said, so there is nothing to name it after.
    assert.equal(sessions[1]?.title, 'Untitled session');
  });
});

test('reads a transcript in order and keeps only what was said', async () => {
  await withStore(async ({ db, engine }) => {
    seed(db, [
      {
        id: 'ses_read',
        directory: WORKSPACE,
        title: 'Read me',
        timeCreated: 1786000000000,
        timeUpdated: 1786000003000,
        messages: [
          {
            id: 'msg_1',
            role: 'user',
            timeCreated: 1786000000000,
            parts: [text('list the files')],
          },
          {
            id: 'msg_2',
            role: 'assistant',
            timeCreated: 1786000001000,
            parts: [
              { type: 'step-start', snapshot: 'abc' },
              { type: 'reasoning', text: 'the user probably wants a listing' },
              text('Looking now.'),
              {
                type: 'tool',
                tool: 'bash',
                callID: 'toolu_1',
                state: { status: 'completed', input: { command: 'ls -la' }, output: 'one\ntwo' },
              },
              { type: 'patch', hash: 'def' },
              { type: 'step-finish', tokens: { input: 10, output: 2 } },
            ],
          },
          {
            id: 'msg_3',
            role: 'assistant',
            timeCreated: 1786000002000,
            parts: [text('Two files.'), text('Both readable.')],
          },
        ],
      },
    ]);

    const content = await engine.readSessionContent('ses_read', WORKSPACE);

    assert.equal(content.engineSessionId, 'ses_read');
    assert.deepEqual(content.messages, [
      { role: 'user', content: 'list the files' },
      // Thinking, bookkeeping and the tool call are all left out of what was said.
      { role: 'assistant', content: 'Looking now.' },
      { role: 'assistant', content: 'Two files.\nBoth readable.' },
    ]);
    assert.deepEqual(content.activities, [
      { id: 'toolu_1', tool: 'bash', target: 'ls -la', output: 'one\ntwo' },
    ]);
  });
});

test('reports a session id it cannot find as a plain error', async () => {
  await withStore(async ({ db, engine }) => {
    seed(db, [
      {
        id: 'ses_here',
        directory: WORKSPACE,
        title: 'Here',
        timeCreated: 1786000000000,
        timeUpdated: 1786000000000,
      },
    ]);

    await assert.rejects(engine.readSessionContent('ses_gone', WORKSPACE), (error: unknown) => {
      assert.ok(error instanceof Error);
      // Not a scan that could not run, so not the unsupported error.
      assert.ok(!(error instanceof SessionScanUnsupportedError));
      assert.match(error.message, /ses_gone/);
      return true;
    });

    // The same session under a directory it was never started in is not this
    // workspace's to import.
    await assert.rejects(engine.readSessionContent('ses_here', '/Users/someone/other'), Error);
  });
});

test('reports an opencode that has never run as no history', async () => {
  await withStore(async ({ engine }) => {
    assert.deepEqual(await engine.listLocalSessions(WORKSPACE), []);
  });
});

test('lets a database it cannot read surface as unsupported', async () => {
  await withStore(async ({ db, engine }) => {
    await writeFile(db, 'this is not a database, it only has the name of one');

    await assert.rejects(engine.listLocalSessions(WORKSPACE), SessionScanUnsupportedError);
    await assert.rejects(
      engine.readSessionContent('ses_anything', WORKSPACE),
      SessionScanUnsupportedError,
    );
  });
});

/** A text part, which is the only part a message is said in. */
function text(value: string): Record<string, unknown> {
  return { type: 'text', text: value };
}
