import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalNumberSchema,
  ENGINE_TEXT_MAX_LENGTH,
  pairingCodeSchema,
  parseBrowserMessage,
  parseCliMessage,
  PROMPT_MAX_LENGTH,
  serverToBrowserMessageSchema,
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

/** A copy of a message with fields removed, for asserting they are required. */
function without(message: object, ...fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(message).filter(([key]) => !fields.includes(key)));
}

const ask = {
  type: 'turn_permission_request',
  turnId: 'turn-1',
  permissionId: 'per-1',
  tool: 'Bash',
  title: 'Bash',
  target: 'curl -s https://example.com',
  reason: 'This command requires approval',
  details: ['Fetch example.com'],
  suggestions: ['Bash(curl *)'],
};

test('an ask carries everything the browser has to show', () => {
  assert.notEqual(parseCliMessage(JSON.stringify(ask)), undefined);

  // What the tool acted on and why it is asking are the two things the engine may
  // not say, so only those are allowed to be missing.
  assert.notEqual(parseCliMessage(JSON.stringify(without(ask, 'target', 'reason'))), undefined);

  for (const field of ['tool', 'title', 'details', 'suggestions', 'permissionId']) {
    assert.equal(
      parseCliMessage(JSON.stringify(without(ask, field))),
      undefined,
      `${field} must be required`,
    );
  }
});

test('an ask without a turn cannot be answered, so it is not a message', () => {
  // The turn is what ties an ask to the run waiting on it. Without it the answer
  // has nowhere to go.
  assert.equal(parseCliMessage(JSON.stringify(without(ask, 'turnId'))), undefined);
});

test('a decision is one of the three a person can make', () => {
  for (const decision of ['once', 'always', 'reject']) {
    const message = JSON.stringify({
      type: 'permission_response',
      conversationId: 'conv-1',
      permissionId: 'per-1',
      decision,
    });

    assert.notEqual(parseBrowserMessage(message), undefined);
  }

  // Expiry is what happens when nobody answers, not something a browser may
  // claim. Accepting it here would let a tab refuse an ask and call it a timeout.
  const expired = JSON.stringify({
    type: 'permission_response',
    conversationId: 'conv-1',
    permissionId: 'per-1',
    decision: 'expired',
  });

  assert.equal(parseBrowserMessage(expired), undefined);
});

test('an answer names the conversation it belongs to', () => {
  const anonymous = JSON.stringify({
    type: 'permission_response',
    permissionId: 'per-1',
    decision: 'once',
  });

  // An approval runs a tool call on someone's machine. A guessed ask id must not
  // be enough on its own. See ADR-022.
  assert.equal(parseBrowserMessage(anonymous), undefined);
});

test('an answer to the CLI names both the turn and the ask', () => {
  const complete = {
    type: 'permission_response',
    turnId: 'turn-1',
    permissionId: 'per-1',
    decision: 'reject',
  };

  assert.equal(serverToCliMessageSchema.safeParse(complete).success, true);
  assert.equal(serverToCliMessageSchema.safeParse(without(complete, 'turnId')).success, false);
});

test('an ask sent to the browser says when it stops being answerable', () => {
  const complete = {
    type: 'permission_request',
    conversationId: 'conv-1',
    turnId: 'turn-1',
    permissionId: 'per-1',
    tool: 'Bash',
    title: 'Bash',
    details: ['Fetch example.com'],
    suggestions: [],
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_600_000,
  };

  assert.equal(serverToBrowserMessageSchema.safeParse(complete).success, true);

  // Without a deadline from the server, two phones would count down differently
  // and one of them would offer a card that is already dead.
  assert.equal(
    serverToBrowserMessageSchema.safeParse(without(complete, 'expiresAt')).success,
    false,
  );
});

test('a resolved ask reports how it ended, including nobody answering', () => {
  for (const outcome of ['once', 'always', 'reject', 'expired']) {
    const message = {
      type: 'permission_resolved',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      permissionId: 'per-1',
      outcome,
    };

    assert.equal(serverToBrowserMessageSchema.safeParse(message).success, true);
  }
});

test('a prompt has a length the browser cannot exceed', () => {
  const prompt = (length: number): string =>
    JSON.stringify({
      type: 'prompt',
      conversationId: '3f8c1e42-2a5b-4f7d-9c11-6b2d0e5a7c93',
      text: 'x'.repeat(length),
    });

  // Everything a prompt carries is stored, and the browser socket is reachable
  // before anything has been proved, so this is the one field an unknown sender
  // controls. See ADR-030.
  assert.notEqual(parseBrowserMessage(prompt(PROMPT_MAX_LENGTH)), undefined);
  assert.equal(parseBrowserMessage(prompt(PROMPT_MAX_LENGTH + 1)), undefined);
});

test('engine output has a length the CLI cannot exceed', () => {
  const output = (length: number): string =>
    JSON.stringify({
      type: 'turn_activity_output',
      turnId: '9d4b7c10-8e3f-4a26-b5d8-1c0f9a2e6b74',
      activityId: 'call-1',
      output: 'x'.repeat(length),
    });

  assert.notEqual(parseCliMessage(output(ENGINE_TEXT_MAX_LENGTH)), undefined);
  assert.equal(parseCliMessage(output(ENGINE_TEXT_MAX_LENGTH + 1)), undefined);
});

test('the engine may say more than a person may ask', () => {
  // A command's output is not typed by anyone, so holding it to the prompt limit
  // would truncate ordinary work.
  assert.ok(ENGINE_TEXT_MAX_LENGTH > PROMPT_MAX_LENGTH);
});

test('an answer longer than the limit is not a message', () => {
  const done = JSON.stringify({
    type: 'turn_done',
    turnId: '9d4b7c10-8e3f-4a26-b5d8-1c0f9a2e6b74',
    text: 'x'.repeat(ENGINE_TEXT_MAX_LENGTH + 1),
  });

  // Which is why the CLI shortens before sending: a refused turn_done would leave
  // the browser waiting forever for an answer that had already arrived.
  assert.equal(parseCliMessage(done), undefined);
});
