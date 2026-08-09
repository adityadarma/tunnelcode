import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationRepository } from '../dist/db/conversation-repository.js';
import { SessionRepository } from '../dist/db/session-repository.js';
import { reopenDb, withTempDb } from './db-helpers.ts';

const session = {
  sessionId: 'session-1',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engine: 'opencode',
  // Stands in for the hash of a real token: the browser is not in this test, so
  // nothing has to be able to present it.
  tokenHash: 'token-hash-1',
};

test('an approved pairing is persisted', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);

    assert.equal(sessions.findSession('session-1')?.deviceId, 'device-1');
    assert.equal(sessions.countDevices(), 1);
  });
});

test('a device that pairs repeatedly stays one row', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);
    sessions.persistApproved({ ...session, sessionId: 'session-2', deviceName: 'Renamed Mac' });

    assert.equal(sessions.countDevices(), 1);
    assert.equal(sessions.findSessionDetail('session-2')?.deviceName, 'Renamed Mac');
    // The earlier session must survive the second pairing.
    assert.notEqual(sessions.findSession('session-1'), undefined);
  });
});

test('sessions can be listed per device', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);
    sessions.persistApproved({ ...session, sessionId: 'session-2' });

    assert.deepEqual(sessions.listSessionIdsByDevice('device-1').sort(), [
      'session-1',
      'session-2',
    ]);
  });
});

test('messages are stored in order', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.appendMessage(conversation.id, 'user', 'first');
    conversations.appendMessage(conversation.id, 'assistant', 'second');
    conversations.appendMessage(conversation.id, 'user', 'third');

    assert.deepEqual(
      conversations.listMessages(conversation.id).map((message) => message.content),
      ['first', 'second', 'third'],
    );
  });
});

test('the title comes from the first user message only', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    assert.equal(conversation.title, null);

    conversations.appendMessage(conversation.id, 'user', '  Explain   how\nthings work  ');
    conversations.appendMessage(conversation.id, 'assistant', 'Like this.');
    conversations.appendMessage(conversation.id, 'user', 'a later question');

    // Whitespace is collapsed for the title, but the message stays verbatim.
    assert.equal(conversations.findById(conversation.id)?.title, 'Explain how things work');
    assert.equal(
      conversations.listMessages(conversation.id)[0]?.content,
      '  Explain   how\nthings work  ',
    );
  });
});

test('a long title is truncated', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.appendMessage(conversation.id, 'user', 'x'.repeat(200));

    const title = conversations.findById(conversation.id)?.title ?? '';
    assert.ok(title.length <= 60);
    assert.ok(title.endsWith('…'));
  });
});

test('conversations are listed per session', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    new SessionRepository(handle.db).persistApproved({ ...session, sessionId: 'session-2' });
    const conversations = new ConversationRepository(handle.db);

    conversations.create('session-1');
    conversations.create('session-1');
    conversations.create('session-2');

    assert.equal(conversations.listBySession('session-1').length, 2);
    assert.equal(conversations.listBySession('session-2').length, 1);
  });
});

test('sessions are listed per workspace on a device', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);
    sessions.persistApproved({ ...session, sessionId: 'session-2' });
    // Same device id would be impossible for a different workspace in practice,
    // but the workspace is compared rather than trusted, so this must not match.
    sessions.persistApproved({ ...session, sessionId: 'other-workspace', workspace: '/elsewhere' });
    sessions.persistApproved({
      ...session,
      sessionId: 'other-device',
      deviceId: 'device-2',
      deviceName: 'Other Mac',
    });

    assert.deepEqual(sessions.listSessionIdsForWorkspace('device-1', '/work').sort(), [
      'session-1',
      'session-2',
    ]);
  });
});

test('an ended session still counts as the same workspace', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);
    sessions.markEnded('session-1');
    sessions.persistApproved({ ...session, sessionId: 'session-2' });

    // Ending a pairing retires that session, it does not discard what was said in
    // the workspace.
    assert.deepEqual(sessions.listSessionIdsForWorkspace('device-1', '/work').sort(), [
      'session-1',
      'session-2',
    ]);
  });
});

test('conversations from several sessions are read as one list', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db);
    sessions.persistApproved(session);
    sessions.persistApproved({ ...session, sessionId: 'session-2' });
    const conversations = new ConversationRepository(handle.db);

    const first = conversations.create('session-1');
    const second = conversations.create('session-2');

    // Ordered by age, so re-pairing does not reshuffle what the user already knows.
    assert.deepEqual(
      conversations.listBySessions(['session-1', 'session-2']).map((item) => item.id),
      [first.id, second.id],
    );
  });
});

test('reading no sessions yields no conversations', async () => {
  await withTempDb(async (handle) => {
    const conversations = new ConversationRepository(handle.db);

    // An empty id list must not turn into a query that matches everything.
    assert.deepEqual(conversations.listBySessions([]), []);
  });
});

test('history survives reopening the database', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.appendMessage(conversation.id, 'user', 'does this survive');
    conversations.appendMessage(conversation.id, 'assistant', 'yes');
    handle.close();

    // Stands in for a restarted server pointed at the same file.
    await reopenDb(file, async (reopened) => {
      const reloaded = new ConversationRepository(reopened.db);

      assert.deepEqual(
        reloaded.listMessages(conversation.id).map((message) => message.content),
        ['does this survive', 'yes'],
      );
      assert.equal(new SessionRepository(reopened.db).countDevices(), 1);
    });
  });
});

test('an unknown conversation has no rows', async () => {
  await withTempDb(async (handle) => {
    const conversations = new ConversationRepository(handle.db);

    assert.equal(conversations.findById('nope'), undefined);
    assert.deepEqual(conversations.listMessages('nope'), []);
    assert.deepEqual(conversations.listActivities('nope'), []);
  });
});

test('deleting a conversation removes its messages and activities', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.appendMessage(conversation.id, 'user', 'hello');
    conversations.appendActivity(conversation.id, 'id3', 'Bash', 'ls');

    assert.equal(conversations.delete(conversation.id), true);
    assert.equal(conversations.findById(conversation.id), undefined);
    assert.deepEqual(conversations.listMessages(conversation.id), []);
    assert.deepEqual(conversations.listActivities(conversation.id), []);
    assert.equal(conversations.delete('nope'), false);
  });
});

test('activities are stored in order', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.appendActivity(conversation.id, 'id1', 'Read', 'a.ts');
    conversations.appendActivity(conversation.id, 'id2', 'Write', 'b.ts');
    conversations.appendActivity(conversation.id, 'id3', 'Bash', 'pnpm test');

    assert.deepEqual(
      conversations.listActivities(conversation.id).map((item) => [item.tool, item.target]),
      [
        ['Read', 'a.ts'],
        ['Write', 'b.ts'],
        ['Bash', 'pnpm test'],
      ],
    );
  });
});

test('an activity without a target is stored as null', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    const stored = conversations.appendActivity(conversation.id, 'id5', 'TodoWrite', undefined);

    // Null rather than an empty string, so "the engine did not say" stays
    // distinguishable from "it acted on nothing".
    assert.equal(stored.target, null);
    assert.equal(conversations.listActivities(conversation.id)[0]?.target, null);
  });
});

test('an activity never becomes a message', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.appendActivity(conversation.id, 'id2', 'Write', 'a.ts');

    // An activity is not conversation text, so it must not show up as one.
    assert.deepEqual(conversations.listMessages(conversation.id), []);
  });
});

test('an activity does not name the conversation', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.appendActivity(conversation.id, 'id2', 'Write', 'a.ts');

    // The title comes from what the user asked, so a tool call must leave it
    // untouched and let the first prompt still name it.
    assert.equal(conversations.findById(conversation.id)?.title, null);

    conversations.appendMessage(conversation.id, 'user', 'now ask something');
    assert.equal(conversations.findById(conversation.id)?.title, 'now ask something');
  });
});

test('activities survive reopening the database', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.appendActivity(conversation.id, 'id2', 'Write', 'note.txt');
    handle.close();

    await reopenDb(file, async (reopened) => {
      const reloaded = new ConversationRepository(reopened.db);

      // The whole point of storing these is that a refresh still shows what the
      // engine changed.
      assert.deepEqual(
        reloaded.listActivities(conversation.id).map((item) => item.tool),
        ['Write'],
      );
    });
  });
});

test('a fresh conversation has no engine session', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    // Nothing to continue yet, which is also the state of every conversation
    // created before this column existed.
    assert.equal(conversations.findEngineSession(conversation.id), undefined);
  });
});

test('an engine session is recorded with its engine', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.setEngineSession(conversation.id, 'engine-session-1', 'claude');

    // The engine travels with the id, because an id only means something to the
    // engine that issued it.
    assert.deepEqual(conversations.findEngineSession(conversation.id), {
      id: 'engine-session-1',
      engine: 'claude',
    });
  });
});

test('a later turn replaces the recorded engine session', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.setEngineSession(conversation.id, 'first', 'claude');
    conversations.setEngineSession(conversation.id, 'second', 'claude');

    // A stale id is retried without resuming and yields a new one, which has to
    // take over or the conversation would resume into the dead id forever.
    assert.equal(conversations.findEngineSession(conversation.id)?.id, 'second');
  });
});

test('an engine session survives reopening the database', async () => {
  await withTempDb(async (handle, file) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');
    conversations.setEngineSession(conversation.id, 'engine-session-1', 'claude');
    handle.close();

    await reopenDb(file, async (reopened) => {
      const reloaded = new ConversationRepository(reopened.db);

      // The whole point is that reopening a conversation later still continues the
      // same agent context.
      assert.deepEqual(reloaded.findEngineSession(conversation.id), {
        id: 'engine-session-1',
        engine: 'claude',
      });
    });
  });
});

test('an engine session belongs to one conversation only', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const first = conversations.create('session-1');
    const second = conversations.create('session-1');

    conversations.setEngineSession(first.id, 'engine-session-1', 'claude');

    // A new conversation has to start a new engine conversation, otherwise both
    // would share one agent context.
    assert.equal(conversations.findEngineSession(second.id), undefined);
  });
});

test('recording an engine session does not name the conversation', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const conversation = conversations.create('session-1');

    conversations.setEngineSession(conversation.id, 'engine-session-1', 'claude');

    // The title comes from what the user asked, so this must leave it alone.
    assert.equal(conversations.findById(conversation.id)?.title, null);
  });
});

test('activities belong to their own conversation', async () => {
  await withTempDb(async (handle) => {
    new SessionRepository(handle.db).persistApproved(session);
    const conversations = new ConversationRepository(handle.db);
    const first = conversations.create('session-1');
    const second = conversations.create('session-1');

    conversations.appendActivity(first.id, 'id6', 'Read', 'a.ts');

    assert.equal(conversations.listActivities(first.id).length, 1);
    assert.deepEqual(conversations.listActivities(second.id), []);
  });
});
