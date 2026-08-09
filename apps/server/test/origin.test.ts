import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin } from '../dist/ws/origin.js';
import { connect, withServer } from './server-helpers.ts';

test('a page on this server is allowed', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000', ['127.0.0.1:3000']), true);
  // The scheme is not compared: the same host over https is still the same page.
  assert.equal(isAllowedOrigin('https://agent.example.com', ['agent.example.com']), true);
});

test('a page somewhere else is refused', () => {
  assert.equal(isAllowedOrigin('http://evil.example', ['127.0.0.1:3000']), false);
  // A different port is a different origin, which is the case a page on the same
  // machine would have.
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173', ['127.0.0.1:3000']), false);
  // Ends with the right host but is not it.
  assert.equal(isAllowedOrigin('http://evil.example/127.0.0.1:3000', ['127.0.0.1:3000']), false);
});

test('a handshake with no origin is allowed', () => {
  // The CLI is not a browser and sends none. A page cannot use this: a browser
  // always sends the header and script cannot remove it.
  assert.equal(isAllowedOrigin(undefined, ['127.0.0.1:3000']), true);
  assert.equal(isAllowedOrigin('', ['127.0.0.1:3000']), true);
});

test('an origin that names no host is refused', () => {
  // What a sandboxed iframe and a file:// page send.
  assert.equal(isAllowedOrigin('null', ['127.0.0.1:3000']), false);
  assert.equal(isAllowedOrigin('not a url', ['127.0.0.1:3000']), false);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000', [undefined, '']), false);
});

test('the forwarded name is accepted when a proxy supplied it', () => {
  assert.equal(
    isAllowedOrigin('https://agent.example.com', ['127.0.0.1:3000', 'agent.example.com']),
    true,
  );
});

test('the browser socket refuses a handshake from another site', async () => {
  await withServer(async ({ baseUrl }) => {
    await assert.rejects(
      connect(baseUrl, '/ws/browser', { origin: 'http://evil.example' }),
      /403/,
      'a page the user merely visited must not reach the socket at all',
    );
  });
});

test('the CLI socket refuses a handshake from another site', async () => {
  await withServer(async ({ baseUrl }) => {
    await assert.rejects(connect(baseUrl, '/ws/cli', { origin: 'http://evil.example' }), /403/);
  });
});

test('the browser socket accepts its own page and a client with no origin', async () => {
  await withServer(async ({ baseUrl }) => {
    const host = baseUrl.replace('http://', '');

    const sameSite = await connect(baseUrl, '/ws/browser', { origin: baseUrl });
    sameSite.close();

    const noOrigin = await connect(baseUrl, '/ws/cli');
    noOrigin.close();

    assert.ok(host !== '');
  });
});

test('a frame nobody would send closes the socket', async () => {
  await withServer(async ({ baseUrl }) => {
    const browser = await connect(baseUrl, '/ws/browser');

    const closed = new Promise<number>((resolve) => {
      browser.socket.on('close', (code: number) => {
        resolve(code);
      });
    });

    // Far past anything the protocol accepts. `ws` allows 100 MiB by default, so
    // without a limit this became a string the server had to hold and parse before
    // any schema got a say. See ADR-030.
    browser.socket.send(JSON.stringify({ type: 'prompt', text: 'x'.repeat(4_000_000) }));

    // 1009 is 'message too big', which is the transport refusing rather than the
    // schema.
    assert.equal(await closed, 1009);
  });
});
