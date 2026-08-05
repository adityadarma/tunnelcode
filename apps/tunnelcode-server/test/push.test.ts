import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { PushRepository } from '../dist/db/push-repository.js';
import { SessionRepository } from '../dist/db/session-repository.js';
import { PushService } from '../dist/services/push.js';
import { BrowserRegistry } from '../dist/ws/browser-registry.js';
import { withTempDb } from './db-helpers.ts';
import type { DbHandle } from '../dist/db/client.js';
import {
  connect,
  currentCookie,
  getJson,
  postJson,
  useCookie,
  waitUntil,
  withServer,
} from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

interface CliEvent {
  type: string;
  requestId?: string;
}

interface BrowserEvent {
  type: string;
}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A subscription that can actually be encrypted for, standing in for a browser. */
function fakeSubscription(endpoint: string): Subscription {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();

  return {
    endpoint,
    p256dh: receiver.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  };
}

/** How many subscriptions the server is holding, which no route reports. */
function countSubscriptions(databaseFile: string): number {
  const db = new DatabaseConstructor(databaseFile, { readonly: true });

  try {
    const row = db.prepare('select count(*) as total from push_subscriptions').get() as {
      total: number;
    };
    return row.total;
  } finally {
    db.close();
  }
}

/** Pairs a device and returns the session, leaving its cookie in the jar. */
async function pair(baseUrl: string, code: string, deviceId: string): Promise<string> {
  const cli: Recorder<CliEvent> = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send({
    type: 'register',
    code,
    deviceId,
    deviceName: 'Test Mac',
    workspace: `/work/${deviceId}`,
    engines: [{ name: 'claude', models: ['sonnet'] }],
  });
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));
  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/pair/${String(request.body['requestId'])}/status`);

  cli.close();

  return String(status.body['sessionId']);
}

/** Subscribes the session whose cookie is in play. */
async function subscribe(baseUrl: string, subscription: Subscription): Promise<{ status: number }> {
  return postJson(baseUrl, '/api/push/subscribe', {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  });
}

/**
 * Runs something with the network replaced.
 *
 * A push service is the one participant this project cannot start, so the request
 * that would go to one is captured instead. Restored in a finally, or every later
 * test would be talking to this stub.
 */
async function withFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) =>
    handler(input instanceof Request ? input.url : String(input), init);

  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A session for a subscription to belong to.
 *
 * The row has to exist because a subscription references it, which is what makes a
 * retired pairing take its notifications with it.
 */
function seedSession(handle: DbHandle, sessionId: string): void {
  new SessionRepository(handle.db).persistApproved({
    sessionId,
    deviceId: `device-for-${sessionId}`,
    deviceName: 'Test Mac',
    workspace: '/work',
    engine: 'claude',
    tokenHash: `token-hash-${sessionId}`,
    runIdHash: null,
  });
}

/** Notifying does not wait for delivery, so the sends have to be given a moment. */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
};

test('the signing key is only offered to a paired browser, and never changes', async () => {
  await withServer(async ({ baseUrl }) => {
    const anonymous = await getJson(baseUrl, '/api/push/key');
    assert.equal(anonymous.status, 401);

    await pair(baseUrl, 'ABCDEFGH', 'device-1');

    const first = await getJson(baseUrl, '/api/push/key');
    assert.equal(first.status, 200);

    // Uncompressed P-256, which is 65 bytes, and the form a browser subscribes with.
    const key = String(first.body['publicKey']);
    assert.equal(Buffer.from(key, 'base64url').length, 65);

    // Stored rather than generated per request: a subscription is made against one
    // key, and a second key would retire it. See ADR-045.
    const second = await getJson(baseUrl, '/api/push/key');
    assert.equal(String(second.body['publicKey']), key);
  });
});

test('a subscription is refused without a session, and unless it is https', async () => {
  await withServer(async ({ baseUrl }) => {
    const subscription = fakeSubscription('https://push.example.com/one');

    assert.equal((await subscribe(baseUrl, subscription)).status, 401);

    await pair(baseUrl, 'ABCDEFGH', 'device-1');

    // The endpoint is a URL this server will post to, so it is checked rather than
    // stored as given.
    const plain = await subscribe(baseUrl, {
      ...subscription,
      endpoint: 'http://push.example.com/one',
    });
    assert.equal(plain.status, 400);

    const missingKeys = await postJson(baseUrl, '/api/push/subscribe', {
      endpoint: subscription.endpoint,
    });
    assert.equal(missingKeys.status, 400);

    assert.equal((await subscribe(baseUrl, subscription)).status, 204);
  });
});

test('one session cannot turn off the notifications of another', async () => {
  await withServer(async ({ baseUrl, databaseFile }) => {
    const subscription = fakeSubscription('https://push.example.com/owned');

    await pair(baseUrl, 'ABCDEFGH', 'device-1');
    const ownerCookie = currentCookie(baseUrl);

    await subscribe(baseUrl, subscription);
    assert.equal(countSubscriptions(databaseFile), 1);

    // A second paired browser, which knows the endpoint only because this test hands
    // it over. An endpoint travels in a request body, so nothing about it is secret.
    await pair(baseUrl, 'IJKLMNOP', 'device-2');

    const refused = await postJson(baseUrl, '/api/push/unsubscribe', {
      endpoint: subscription.endpoint,
    });
    // Answered the same either way, so a reply never reports whether an endpoint is
    // known. What matters is that the row survived.
    assert.equal(refused.status, 204);
    assert.equal(countSubscriptions(databaseFile), 1);

    useCookie(baseUrl, ownerCookie);
    const given = await postJson(baseUrl, '/api/push/unsubscribe', {
      endpoint: subscription.endpoint,
    });
    assert.equal(given.status, 204);
    assert.equal(countSubscriptions(databaseFile), 0);
  });
});

test('subscriptions end with the session they were filed against', async () => {
  await withServer(async ({ baseUrl, databaseFile }) => {
    const subscription = fakeSubscription('https://push.example.com/ends');
    const sessionId = await pair(baseUrl, 'ABCDEFGH', 'device-1');

    await subscribe(baseUrl, subscription);
    assert.equal(countSubscriptions(databaseFile), 1);

    const browser = await connect<BrowserEvent>(baseUrl, '/ws/browser');
    browser.send({ type: 'attach', sessionId });
    await browser.waitFor((events) => events.some((event) => event.type === 'attached'));
    // Disconnecting retires the session, and a browser told about an agent it can no
    // longer reach would be a notification with nowhere to go.
    browser.send({ type: 'disconnect' });

    await waitUntil(
      async () => countSubscriptions(databaseFile) === 0,
      'the subscription to be dropped with the session',
    );

    browser.close();
  });
});

test('nothing is sent while a browser is watching', async () => {
  await withTempDb(async (handle) => {
    const browsers = new BrowserRegistry();
    const repository = new PushRepository(handle.db);
    const sent: string[] = [];
    const push = new PushService({ repository, browsers, log: () => undefined });

    // Written straight to the repository: this is about what the service decides,
    // not about how a browser came to be subscribed.
    seedSession(handle, 'session-1');
    repository.save({ sessionId: 'session-1', ...fakeSubscription('https://push.example.com/a') });
    browsers.add('session-1', { send: () => undefined });

    await withFetch(
      async (url) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      },
      async () => {
        push.notify('session-1', { kind: 'done', title: 'Ready', body: 'Done' });
        await settle();
      },
    );

    assert.deepEqual(sent, []);
  });
});

test('a closed browser is reached, and a dead endpoint is forgotten', async () => {
  await withTempDb(async (handle) => {
    const browsers = new BrowserRegistry();
    const repository = new PushRepository(handle.db);
    const requests: { url: string; headers: Headers }[] = [];
    const push = new PushService({ repository, browsers, log: () => undefined });

    seedSession(handle, 'session-1');
    repository.save({
      sessionId: 'session-1',
      ...fakeSubscription('https://push.example.com/live'),
    });
    repository.save({
      sessionId: 'session-1',
      ...fakeSubscription('https://push.example.com/gone'),
    });

    await withFetch(
      async (url, init) => {
        requests.push({ url, headers: new Headers(init?.headers) });
        // A push service reporting that an endpoint no longer exists, which is what
        // an uninstalled browser looks like from here.
        return new Response(null, { status: url.endsWith('/gone') ? 410 : 201 });
      },
      async () => {
        push.notify('session-1', {
          kind: 'permission',
          title: 'Approval needed',
          body: 'Bash: curl',
          conversationId: 'conv-1',
        });
        await settle();
      },
    );

    assert.equal(requests.length, 2);

    const live = requests.find((request) => request.url.endsWith('/live'));
    assert.ok(live !== undefined);
    assert.equal(live.headers.get('content-encoding'), 'aes128gcm');
    // An approval holds the agent still, so it is worth waking a sleeping phone for.
    assert.equal(live.headers.get('urgency'), 'high');
    assert.match(String(live.headers.get('authorization')), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);

    assert.deepEqual(
      repository.listBySession('session-1').map((item) => item.endpoint),
      ['https://push.example.com/live'],
    );
  });
});
