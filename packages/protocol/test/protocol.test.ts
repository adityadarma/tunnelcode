import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalNumberSchema,
  pairingCodeSchema,
  parseBrowserMessage,
  parseCliMessage,
} from '../dist/index.js';

test('a pairing code must be 8 uppercase letters', () => {
  assert.equal(pairingCodeSchema.safeParse('ABCDEFGH').success, true);
  assert.equal(pairingCodeSchema.safeParse('ABCDEFG').success, false);
  assert.equal(pairingCodeSchema.safeParse('ABCDEFGHI').success, false);
  assert.equal(pairingCodeSchema.safeParse('ABCD1234').success, false);
});

test('a lowercase code is rejected', () => {
  // Matching is case sensitive, so accepting lowercase here would let a
  // wrong-case code pair.
  assert.equal(pairingCodeSchema.safeParse('abcdefgh').success, false);
  assert.equal(pairingCodeSchema.safeParse('ABCDefgh').success, false);
});

test('an approval number keeps its leading zero', () => {
  assert.equal(approvalNumberSchema.safeParse('0042').success, true);
  assert.equal(approvalNumberSchema.safeParse('42').success, false);
  assert.equal(approvalNumberSchema.safeParse('00420').success, false);
});

test('a malformed frame is not a message', () => {
  assert.equal(parseCliMessage('not json'), undefined);
  assert.equal(parseCliMessage('[]'), undefined);
  assert.equal(parseBrowserMessage('{"type":"nope"}'), undefined);
});

test('register requires every field the server records', () => {
  const complete = JSON.stringify({
    type: 'register',
    code: 'ABCDEFGH',
    deviceId: 'device-1',
    deviceName: 'Test Mac',
    workspace: '/work',
    engine: 'opencode',
    models: ['opencode/fast'],
  });

  assert.notEqual(parseCliMessage(complete), undefined);

  // A missing deviceId would break reconnect, so it cannot be optional.
  const missingId = JSON.stringify({
    type: 'register',
    code: 'ABCDEFGH',
    deviceName: 'Test Mac',
    workspace: '/work',
    engine: 'opencode',
    models: [],
  });

  assert.equal(parseCliMessage(missingId), undefined);
});

test('an empty prompt is refused', () => {
  const empty = JSON.stringify({ type: 'prompt', conversationId: 'c1', text: '' });
  assert.equal(parseBrowserMessage(empty), undefined);

  const valid = JSON.stringify({ type: 'prompt', conversationId: 'c1', text: 'hello' });
  assert.notEqual(parseBrowserMessage(valid), undefined);
});

test('a prompt may omit the model', () => {
  const parsed = parseBrowserMessage(
    JSON.stringify({ type: 'prompt', conversationId: 'c1', text: 'hi' }),
  );

  assert.equal(parsed?.type, 'prompt');
  assert.equal(parsed?.type === 'prompt' ? parsed.model : 'x', undefined);
});

test('attach requires a session id', () => {
  assert.equal(parseBrowserMessage(JSON.stringify({ type: 'attach' })), undefined);
  assert.notEqual(
    parseBrowserMessage(JSON.stringify({ type: 'attach', sessionId: 's1' })),
    undefined,
  );
});
