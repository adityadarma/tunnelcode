import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildContentSecurityPolicy, inlineScriptHashes } from '../dist/security-headers.js';
import { withServer } from './server-helpers.ts';

/** Every inline script in a document, the way a browser reads them for a hash. */
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

test('an inline script is hashed and a file is not', () => {
  const html = [
    '<script>var t = 1;</script>',
    '<script type="module" crossorigin src="/assets/index.js"></script>',
  ].join('\n');

  const hashes = inlineScriptHashes(html);

  // The file is covered by 'self' already; only code carried in the document has
  // to be named.
  assert.equal(hashes.length, 1);
  assert.equal(hashes[0], createHash('sha256').update('var t = 1;', 'utf8').digest('base64'));
});

test('the hash covers the script exactly as written', () => {
  // Indentation and newlines are part of what a browser hashes, so trimming here
  // would produce a policy that refuses the very script it was built from.
  const code = '\n  var t = 1;\n';
  const hashes = inlineScriptHashes(`<script>${code}</script>`);

  assert.equal(hashes[0], createHash('sha256').update(code, 'utf8').digest('base64'));
});

test('a document with no inline script needs no hash', () => {
  assert.deepEqual(inlineScriptHashes('<script src="/a.js"></script>'), []);
  assert.deepEqual(inlineScriptHashes('<p>nothing here</p>'), []);
  // An empty block carries no code to allow.
  assert.deepEqual(inlineScriptHashes('<script></script>'), []);
});

test('the policy refuses framing and names nothing but this server', () => {
  const policy = buildContentSecurityPolicy(['abc123']);

  // The directive the approval card depends on: a page that can frame this app
  // can lay its own controls over Always allow, and the WebSocket origin check
  // cannot see the difference because the frame is this server's own origin.
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /script-src 'self' 'sha256-abc123'/);
});

test('every response carries the headers, and HSTS is not claimed over plain http', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    // Ignored by a browser on a plain connection, and misleading to anyone reading
    // the response. The default deployment is http on loopback.
    assert.equal(response.headers.get('strict-transport-security'), null);
  });
});

test('a refused request carries the headers too', async () => {
  await withServer(async ({ baseUrl }) => {
    // A 404 is a response a browser renders, so it needs the same policy as a page.
    const missing = await fetch(`${baseUrl}/conversations/nope/messages`);

    assert.equal(missing.status, 400);
    assert.match(missing.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(missing.headers.get('x-frame-options'), 'DENY');
  });
});

test('the policy allows the inline script of the document it is sent with', async (t) => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/`);
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('text/html')) {
      // Only the built app serves a document, and the server runs without one.
      t.skip('the web app is not built, so there is no document to check');
      return;
    }

    const policy = response.headers.get('content-security-policy') ?? '';
    const html = await response.text();
    const scripts = [...html.matchAll(INLINE_SCRIPT)]
      .map((match) => match[1])
      .filter((code): code is string => code !== undefined && code !== '');

    // The theme script has to run before the first paint, so it is inline and the
    // policy has to name it. Checking the document that was actually served is
    // what stops the two drifting: editing the script changes the hash, and a
    // policy built from anywhere else would then refuse it.
    assert.ok(scripts.length > 0, 'the document has an inline script to allow');

    for (const code of scripts) {
      const hash = createHash('sha256').update(code, 'utf8').digest('base64');
      assert.ok(
        policy.includes(`'sha256-${hash}'`),
        `the policy does not allow an inline script of the document it was sent with:\n${policy}`,
      );
    }
  });
});
