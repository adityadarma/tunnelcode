import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalNumberSchema,
  pairingCodeSchema,
  parseBrowserMessage,
  parseCliMessage,
  serverToCliMessageSchema,
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
    engines: [{ name: 'opencode', models: ['opencode/fast'] }],
  });

  assert.notEqual(parseCliMessage(complete), undefined);

  // A missing deviceId would break reconnect, so it cannot be optional.
  const missingId = JSON.stringify({
    type: 'register',
    code: 'ABCDEFGH',
    deviceName: 'Test Mac',
    workspace: '/work',
    engines: [{ name: 'opencode', models: [] }],
  });

  assert.equal(parseCliMessage(missingId), undefined);
});

test('register must offer at least one engine', () => {
  // A CLI with no engine installed cannot answer anything, so registering one
  // would only produce a session whose every prompt fails. See ADR-020.
  const none = JSON.stringify({
    type: 'register',
    code: 'ABCDEFGH',
    deviceId: 'device-1',
    deviceName: 'Test Mac',
    workspace: '/work',
    engines: [],
  });

  assert.equal(parseCliMessage(none), undefined);
});

test('register carries the models of each engine separately', () => {
  const parsed = parseCliMessage(
    JSON.stringify({
      type: 'register',
      code: 'ABCDEFGH',
      deviceId: 'device-1',
      deviceName: 'Test Mac',
      workspace: '/work',
      engines: [
        { name: 'opencode', models: ['opencode/fast'] },
        { name: 'claude', models: ['sonnet', 'haiku'] },
      ],
    }),
  );

  // Models belong to an engine, so a browser can never offer one engine's model
  // for another.
  assert.equal(parsed?.type, 'register');
  assert.deepEqual(parsed?.type === 'register' ? parsed.engines[1] : undefined, {
    name: 'claude',
    models: ['sonnet', 'haiku'],
  });
});

test('a prompt to the CLI names the engine to run', () => {
  assert.equal(
    serverToCliMessageSchema.safeParse({
      type: 'prompt',
      turnId: 't1',
      text: 'hi',
      engine: 'claude',
    }).success,
    true,
  );

  // Without it the CLI would have to guess which of its engines to use.
  assert.equal(
    serverToCliMessageSchema.safeParse({ type: 'prompt', turnId: 't1', text: 'hi' }).success,
    false,
  );
});

test('a browser prompt carries no engine or model', () => {
  // Both belong to the conversation and are read from it on the server, so two
  // tabs cannot disagree about which engine answers. See ADR-020.
  const parsed = parseBrowserMessage(
    JSON.stringify({
      type: 'prompt',
      conversationId: 'c1',
      text: 'hi',
      engine: 'claude',
      model: 'sonnet',
    }),
  );

  assert.equal(parsed?.type, 'prompt');
  assert.equal('engine' in (parsed ?? {}), false);
  assert.equal('model' in (parsed ?? {}), false);
});

test('an empty prompt is refused', () => {
  const empty = JSON.stringify({ type: 'prompt', conversationId: 'c1', text: '' });
  assert.equal(parseBrowserMessage(empty), undefined);

  const valid = JSON.stringify({ type: 'prompt', conversationId: 'c1', text: 'hello' });
  assert.notEqual(parseBrowserMessage(valid), undefined);
});

test('attach requires a session id', () => {
  assert.equal(parseBrowserMessage(JSON.stringify({ type: 'attach' })), undefined);
  assert.notEqual(
    parseBrowserMessage(JSON.stringify({ type: 'attach', sessionId: 's1' })),
    undefined,
  );
});
