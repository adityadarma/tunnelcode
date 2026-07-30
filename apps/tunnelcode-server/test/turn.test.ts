import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnService } from '../dist/services/turn.js';

const input = {
  sessionId: 'session-1',
  deviceId: 'device-1',
  conversationId: 'conversation-1',
};

test('a started turn is found for its own device', () => {
  const turns = new TurnService();
  const turn = turns.start(input);

  assert.equal(turns.findForDevice(turn.id, 'device-1')?.id, turn.id);
});

test('a turn is invisible to another device', () => {
  const turns = new TurnService();
  const turn = turns.start(input);

  // Otherwise one CLI could write output into another device's turn.
  assert.equal(turns.findForDevice(turn.id, 'device-2'), undefined);
});

test('a device is busy while a turn is open', () => {
  const turns = new TurnService();

  assert.equal(turns.hasActiveForDevice('device-1'), false);

  const turn = turns.start(input);
  assert.equal(turns.hasActiveForDevice('device-1'), true);

  turns.finish(turn.id);
  assert.equal(turns.hasActiveForDevice('device-1'), false);
});

test('one device being busy does not block another', () => {
  const turns = new TurnService();
  turns.start(input);

  assert.equal(turns.hasActiveForDevice('device-2'), false);
});

test('a finished turn can no longer be found', () => {
  const turns = new TurnService();
  const turn = turns.start(input);

  turns.finish(turn.id);

  assert.equal(turns.findForDevice(turn.id, 'device-1'), undefined);
});

test('dropping a device returns the turns it abandoned', () => {
  const turns = new TurnService();
  const first = turns.start(input);
  const second = turns.start({ ...input, conversationId: 'conversation-2' });
  turns.start({ ...input, deviceId: 'device-2' });

  const dropped = turns.removeByDevice('device-1');

  // The browsers waiting on those turns have to be told they will never finish.
  assert.deepEqual(dropped.map((turn) => turn.id).sort(), [first.id, second.id].sort());
  assert.equal(turns.hasActiveForDevice('device-1'), false);
  assert.equal(turns.hasActiveForDevice('device-2'), true);
});
