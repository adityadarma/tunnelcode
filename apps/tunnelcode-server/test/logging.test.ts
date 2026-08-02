import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUrl } from '../dist/logging.js';
import { waitUntil, withServer } from './server-helpers.ts';

test('a session id in a path is not written out', () => {
  // The session id is the whole credential a paired browser holds, and it arrives
  // as a path segment on the routes that name a session.
  assert.equal(sanitizeUrl('/sessions/9f2c-secret'), '/sessions/[id]');
  assert.equal(
    sanitizeUrl('/sessions/9f2c-secret/conversations'),
    '/sessions/[id]/conversations',
    'the route has to stay readable after the id is taken out',
  );
  assert.equal(sanitizeUrl('/conversations/abc/messages'), '/conversations/[id]/messages');
  assert.equal(sanitizeUrl('/pair/req-1/status'), '/pair/[id]/status');
});

test('a route with no id in it is left alone', () => {
  assert.equal(sanitizeUrl('/health'), '/health');
  assert.equal(sanitizeUrl('/pair'), '/pair');
  assert.equal(sanitizeUrl('/'), '/');
  assert.equal(sanitizeUrl('/assets/index-abc123.js'), '/assets/index-abc123.js');
});

test('a query value is withheld while its name is kept', () => {
  // This is where the pairing code actually travels: the QR link carries it in the
  // query string, so redacting a field named code never covered it.
  assert.equal(sanitizeUrl('/login?code=ABCDEFGH'), '/login?code=[redacted]');
  assert.equal(
    sanitizeUrl('/login?code=ABCDEFGH&next=/x'),
    '/login?code=[redacted]&next=[redacted]',
  );
  // A question mark with nothing after it says nothing worth writing.
  assert.equal(sanitizeUrl('/login?'), '/login');
});

test('a URL that is not one is still safe to log', () => {
  assert.equal(sanitizeUrl(''), '');
  // Two question marks: everything after the first is the query, however odd.
  assert.equal(sanitizeUrl('/login?a=1?2'), '/login?a=[redacted]');
});

test('the real server logs neither the pairing code nor the session id', async () => {
  const lines: string[] = [];

  await withServer(
    async ({ baseUrl }) => {
      // The QR link, which is the one URL a pairing code appears in.
      await fetch(`${baseUrl}/login?code=ABCDEFGH`);
      // A session route, whether or not the session exists: the id is logged on the
      // way in, long before anything decides it is unknown.
      await fetch(`${baseUrl}/sessions/2b1f9c7e-secret-session-id`);

      await waitUntil(
        async () => lines.join('').includes('/sessions/[id]'),
        'the session route to reach the log',
      );

      const log = lines.join('\n');

      assert.ok(!log.includes('ABCDEFGH'), `the pairing code reached the log:\n${log}`);
      assert.ok(
        !log.includes('2b1f9c7e-secret-session-id'),
        `the session id reached the log:\n${log}`,
      );
      assert.ok(log.includes('/login?code=[redacted]'));
      assert.ok(log.includes('/sessions/[id]'));
    },
    { logLines: lines },
  );
});

test('a rejected request does not log the URL it was rejected for', async () => {
  const lines: string[] = [];

  await withServer(
    async ({ baseUrl }) => {
      // The error handler logs a URL field of its own, outside the request
      // serializer, so it has to sanitize as well. The global limit is what puts a
      // request through it while the URL still names a session.
      const sessionId = 'e41a-another-secret-session-id';
      let refused = false;

      for (let attempt = 0; attempt < 110 && !refused; attempt += 1) {
        const response = await fetch(`${baseUrl}/sessions/${sessionId}`);
        refused = response.status === 429;
      }

      assert.ok(refused, 'the global rate limit never refused a request');

      await waitUntil(
        async () => lines.join('').includes('Request rejected.'),
        'the rate limit to reject a request',
      );

      const log = lines.join('\n');

      assert.ok(!log.includes(sessionId), `the session id reached the log:\n${log}`);
      assert.ok(log.includes('/sessions/[id]'));
    },
    { logLines: lines },
  );
});
