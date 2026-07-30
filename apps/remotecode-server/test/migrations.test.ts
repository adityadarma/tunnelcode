import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ConversationRepository } from '../dist/db/conversation-repository.js';
import { SessionRepository } from '../dist/db/session-repository.js';
import { reopenDb, withTempDb } from './db-helpers.ts';

const session = {
  sessionId: 'session-1',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engine: 'opencode',
};

test('migrations create every table the app needs', async () => {
  await withTempDb(async (_handle, file) => {
    const raw = new Database(file, { readonly: true });
    const tables = raw
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    raw.close();

    for (const expected of ['devices', 'sessions', 'conversations', 'messages']) {
      assert.ok(tables.includes(expected), `missing table: ${expected}`);
    }
  });
});

test('running migrations again keeps existing rows', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.appendMessage(conversation.id, 'user', 'keep me');
    conversations.appendMessage(conversation.id, 'assistant', 'kept');
    handle.close();

    // reopenDb runs the migrator again, which is what happens on every start.
    await reopenDb(file, async (first) => {
      assert.equal(new ConversationRepository(first.db).listMessages(conversation.id).length, 2);
    });

    // A third start must still be harmless.
    await reopenDb(file, async (second) => {
      const reloaded = new ConversationRepository(second.db);

      assert.deepEqual(
        reloaded.listMessages(conversation.id).map((message) => message.content),
        ['keep me', 'kept'],
      );
      assert.equal(new SessionRepository(second.db).countDevices(), 1);
    });
  });
});

test('a message written before the partial flag reads as complete', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    handle.close();

    // Written the way a build that predates the column did, without naming it.
    const raw = new Database(file);
    raw
      .prepare(
        'insert into messages (id, conversation_id, role, content, created_at) values (?, ?, ?, ?, ?)',
      )
      .run('m1', conversation.id, 'assistant', 'an older answer', 1);
    raw.close();

    await reopenDb(file, async (reopened) => {
      const stored = new ConversationRepository(reopened.db).listMessages(conversation.id);

      // The column default is what keeps an existing row valid, so an answer
      // stored before this existed is never shown as cut short.
      assert.equal(stored[0]?.partial, false);
    });
  });
});

test('an activity written before the blocked flag reads as having run', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    handle.close();

    // Written the way a build that predates the columns did, without naming them.
    const raw = new Database(file);
    raw
      .prepare(
        'insert into activities (id, conversation_id, tool, target, created_at) values (?, ?, ?, ?, ?)',
      )
      .run('a1', conversation.id, 'Bash', 'pnpm test', 1);
    raw.close();

    await reopenDb(file, async (reopened) => {
      const stored = new ConversationRepository(reopened.db).listActivities(conversation.id);

      // The column default keeps an existing row valid, so a call that did run is
      // never shown as refused.
      assert.equal(stored[0]?.blocked, false);
      assert.equal(stored[0]?.reason, null);
    });
  });
});

test('the migration journal does not grow on a rerun', async () => {
  await withTempDb(async (handle, file) => {
    handle.close();

    const countApplied = (): number => {
      const raw = new Database(file, { readonly: true });
      const rows = raw.prepare('select count(*) as n from __drizzle_migrations').all();
      raw.close();
      return (rows[0] as { n: number }).n;
    };

    const first = countApplied();
    await reopenDb(file, async () => undefined);

    // A migration that has shipped is never reapplied, which is what keeps a
    // restart from touching existing data.
    assert.equal(countApplied(), first);
  });
});

test('foreign keys are enforced', async () => {
  await withTempDb(async (_handle, file) => {
    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');

    assert.throws(
      () =>
        raw
          .prepare(
            'insert into conversations (id, session_id, created_at, updated_at) values (?, ?, ?, ?)',
          )
          .run('c1', 'no-such-session', 1, 1),
      /FOREIGN KEY/,
    );

    raw.close();
  });
});

test('deleting a device cascades to its history', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.appendMessage(conversation.id, 'user', 'gone soon');
    handle.close();

    const raw = new Database(file);
    raw.pragma('foreign_keys = ON');
    raw.prepare('delete from devices').run();

    const remaining = (table: string): number => {
      const rows = raw.prepare(`select count(*) as n from ${table}`).all();
      return (rows[0] as { n: number }).n;
    };

    assert.equal(remaining('sessions'), 0);
    assert.equal(remaining('conversations'), 0);
    assert.equal(remaining('messages'), 0);
    raw.close();
  });
});

test('write ahead logging is enabled', async () => {
  await withTempDb(async (_handle, file) => {
    const raw = new Database(file, { readonly: true });
    const mode = raw.pragma('journal_mode') as { journal_mode: string }[];
    raw.close();

    // The server reads history while writing new messages.
    assert.equal(mode[0]?.journal_mode, 'wal');
  });
});
