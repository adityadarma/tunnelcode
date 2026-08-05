import { test } from 'node:test';
import assert from 'node:assert/strict';
import DatabaseConstructor from 'better-sqlite3';
import { SessionRepository } from '../dist/db/session-repository.js';
import { withTempDb } from './db-helpers.ts';
import { connect, getJson, postEmpty, postJson, withServer } from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

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

/** Short enough to test, standing in for the hour the app uses. */
const IDLE_MS = 60;

/** Stands in for the twelve hours a session may live however busy it is. */
const MAX_MS = 150;

const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

test('a session that nothing has used stops being valid', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db, { idleMs: IDLE_MS });
    sessions.persistApproved(session);

    assert.notEqual(sessions.findSessionDetail('session-1'), undefined);

    await wait(IDLE_MS + 20);

    // A session id is what lets a browser drive an agent on somebody's machine.
    // One that has been leaked used to keep working forever, because the device id
    // is derived from the machine and the workspace and keeps matching.
    assert.equal(sessions.findSessionDetail('session-1'), undefined);
  });
});

test('activity keeps a session alive', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db, { idleMs: IDLE_MS });
    sessions.persistApproved(session);

    for (let i = 0; i < 3; i += 1) {
      await wait(IDLE_MS / 2);
      sessions.touch('session-1');
    }

    // The window is measured from the last thing that happened, not from pairing,
    // so a conversation in use is never cut off mid-sentence.
    assert.notEqual(sessions.findSessionDetail('session-1'), undefined);
  });
});

test('a session written before activity was recorded falls back to its creation', async () => {
  await withTempDb(async (handle, file) => {
    const sessions = new SessionRepository(handle.db, { idleMs: IDLE_MS });
    sessions.persistApproved(session);

    const raw = new DatabaseConstructor(file);
    try {
      // The shape every row had before the column existed.
      raw.prepare('update sessions set last_activity_at = null').run();
    } finally {
      raw.close();
    }

    // Read as idle since 1970, this would lock the user out of their own history
    // on the first start after an upgrade.
    assert.notEqual(sessions.findSessionDetail('session-1'), undefined);
  });
});

test('a busy session still expires at its ceiling', async () => {
  await withTempDb(async (handle) => {
    // The ceiling is deliberately shorter than three idle windows, so the session
    // below is being used the whole time it is alive.
    const sessions = new SessionRepository(handle.db, { idleMs: IDLE_MS, maxLifetimeMs: MAX_MS });
    sessions.persistApproved(session);

    const started = Date.now();

    for (let i = 0; i < 4; i += 1) {
      await wait(IDLE_MS / 2);
      sessions.touch('session-1');

      // Alive while it is inside the ceiling, so this test is not passing by having
      // watched a session that was never valid to begin with.
      if (Date.now() - started < MAX_MS) {
        assert.notEqual(sessions.findSessionDetail('session-1'), undefined);
      }
    }

    await wait(MAX_MS);

    // Activity moves the idle deadline forward, and activity is exactly what
    // somebody who should not have the credential would produce: one message an
    // hour would otherwise keep a stolen session alive forever. See ADR-039.
    assert.equal(sessions.findSessionDetail('session-1'), undefined);
  });
});

test('an ended session stays ended regardless of activity', async () => {
  await withTempDb(async (handle) => {
    const sessions = new SessionRepository(handle.db, { idleMs: IDLE_MS });
    sessions.persistApproved(session);
    sessions.markEnded('session-1');
    sessions.touch('session-1');

    assert.equal(sessions.findSessionDetail('session-1'), undefined);
  });
});

interface CliEvent {
  type: string;
  requestId?: string;
  turnId?: string;
}

interface BrowserEvent {
  type: string;
}

const register = {
  type: 'register',
  deviceId: 'device-1',
  code: 'ABCDEFGH',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
};

async function pair(baseUrl: string): Promise<{
  cli: Recorder<CliEvent>;
  sessionId: string;
  conversationId: string;
}> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(register);
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);
  const sessionId = String(status.body['sessionId']);
  const conversation = await postEmpty(baseUrl, `/sessions/${sessionId}/conversations`);

  return { cli, sessionId, conversationId: String(conversation.body['id']) };
}

/** What the database says about a session's last activity. */
function activityOf(file: string, sessionId: string): number | null {
  const raw = new DatabaseConstructor(file, { readonly: true });

  try {
    const row = raw
      .prepare('select last_activity_at as activity from sessions where id = ?')
      .get(sessionId) as { activity: number | null } | undefined;

    return row?.activity ?? null;
  } finally {
    raw.close();
  }
}

test('a prompt records activity, attaching does not', async () => {
  await withServer(async ({ baseUrl, databaseFile }) => {
    const { cli, sessionId, conversationId } = await pair(baseUrl);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));

    // A browser reconnecting is not somebody using the agent. Counting it would
    // mean a tab left open on a phone keeps the session alive indefinitely, and
    // the timeout could never be reached.
    assert.equal(activityOf(databaseFile, sessionId), null);

    browser.send({ type: 'prompt', conversationId, text: 'hello' });
    await cli.waitFor((events) => events.some((event) => event.type === 'prompt'));

    const asked = activityOf(databaseFile, sessionId);
    assert.notEqual(asked, null);

    const turnId = String(cli.events.find((event) => event.type === 'prompt')?.turnId);
    cli.send({ type: 'turn_done', turnId, text: 'hi' });
    await browser.waitFor((events) => events.some((event) => event.type === 'turn_done'));

    // The answer counts as well, so a long reply is not measured from the question
    // that started it.
    assert.ok((activityOf(databaseFile, sessionId) ?? 0) >= (asked ?? 0));

    browser.close();
    cli.close();
  });
});
