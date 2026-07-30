import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCliSocketUrl, buildLoginUrl, generatePairingCode } from '../dist/pairing/code.js';

test('pairing code is always 8 uppercase letters', () => {
  for (let i = 0; i < 2000; i += 1) {
    assert.match(generatePairingCode(), /^[A-Z]{8}$/);
  }
});

test('pairing codes do not repeat in a large sample', () => {
  const seen = new Set<string>();

  for (let i = 0; i < 20000; i += 1) {
    seen.add(generatePairingCode());
  }

  // A generator with a weak source or a short period would collide here.
  assert.equal(seen.size, 20000);
});

test('login url carries the code in the query string', () => {
  assert.equal(
    buildLoginUrl('http://127.0.0.1:3000', 'ABCDEFGH'),
    'http://127.0.0.1:3000/login?code=ABCDEFGH',
  );
});

test('login url keeps https and the port', () => {
  assert.equal(
    buildLoginUrl('https://rc.example.com:8443', 'ZZZZZZZZ'),
    'https://rc.example.com:8443/login?code=ZZZZZZZZ',
  );
});

test('socket url follows the server scheme', () => {
  assert.equal(buildCliSocketUrl('http://127.0.0.1:3000'), 'ws://127.0.0.1:3000/ws/cli');
  // A TLS deployment has to end up on wss, otherwise the browser blocks it.
  assert.equal(buildCliSocketUrl('https://rc.example.com'), 'wss://rc.example.com/ws/cli');
});
