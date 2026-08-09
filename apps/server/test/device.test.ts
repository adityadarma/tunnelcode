import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceService } from '../dist/services/device.js';

const base = {
  id: 'device-1',
  code: 'ABCDEFGH',
  name: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
};

/**
 * Device service where every device is treated as connected, which is the state
 * during a normal running session.
 */
const withLiveConnections = (): DeviceService => new DeviceService({ isConnected: () => true });

/**
 * Device service backed by an explicit set of live device ids, so a test can
 * describe a holder whose connection is gone.
 */
const withConnected = (ids: string[]): DeviceService =>
  new DeviceService({ isConnected: (id) => ids.includes(id) });

test('a registered device is found by its code', () => {
  const devices = withLiveConnections();
  const result = devices.register(base);

  assert.equal(result.ok, true);
  assert.equal(devices.findByCode('ABCDEFGH')?.id, 'device-1');
});

test('another device cannot take a code in use', () => {
  const devices = withLiveConnections();
  devices.register(base);

  const result = devices.register({ ...base, id: 'device-2' });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'code_taken');
});

test('a second agent in the same workspace is refused as busy', () => {
  const devices = withLiveConnections();
  devices.register(base);

  // Same machine and workspace means the same device id, but a fresh code. The
  // reason has to say the workspace is busy, not that the code is taken, because
  // this code has never been seen before.
  const result = devices.register({ ...base, code: 'ZZZZZZZZ' });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'workspace_busy');
});

test('the same device may re-register the same code', () => {
  const devices = withLiveConnections();
  devices.register(base);

  // A dropped connection must be able to come back under the code already shown
  // on screen, otherwise reconnect is impossible.
  assert.equal(devices.register(base).ok, true);
});

test('a reconnect keeps the paired flag', () => {
  const devices = withLiveConnections();
  devices.register(base);
  devices.markPaired('device-1');

  const result = devices.register(base);

  // Asserting the returned row, not just the stored one: a rejected re-register
  // would leave the old row untouched and hide the loss of this flag.
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.device.paired : false, true);

  // The code is single use, so it must not become claimable again just because
  // the connection dropped.
  assert.equal(devices.findById('device-1')?.paired, true);
});

test('a reconnect refreshes the engine list', () => {
  const devices = withLiveConnections();
  devices.register(base);

  // An engine installed or removed between runs has to be picked up, otherwise the
  // browser would keep offering an engine the machine no longer has.
  devices.register({ ...base, engines: [{ name: 'claude', models: ['sonnet'] }] });

  assert.deepEqual(devices.findById('device-1')?.engines, [{ name: 'claude', models: ['sonnet'] }]);
  assert.equal(devices.findEngine('device-1', 'opencode'), undefined);
});

test('an engine is looked up with its own models', () => {
  const devices = withLiveConnections();
  devices.register({
    ...base,
    engines: [
      { name: 'opencode', models: ['opencode/fast'] },
      { name: 'claude', models: ['sonnet'] },
    ],
  });

  // Models belong to an engine, so one engine's model must never validate against
  // another. See ADR-020.
  assert.deepEqual(devices.findEngine('device-1', 'claude')?.models, ['sonnet']);
  assert.equal(devices.findEngine('device-1', 'gemini'), undefined);
});

test('removing a device frees its code', () => {
  const devices = withLiveConnections();
  devices.register(base);
  devices.remove('device-1');

  assert.equal(devices.findByCode('ABCDEFGH'), undefined);
  assert.equal(devices.count(), 0);

  // A different device may now use that code.
  assert.equal(devices.register({ ...base, id: 'device-2' }).ok, true);
});

test('a stopped agent frees its workspace', () => {
  const devices = withLiveConnections();
  devices.register(base);
  devices.remove('device-1');

  // Restarting in the same workspace with a new code must work.
  assert.equal(devices.register({ ...base, code: 'ZZZZZZZZ' }).ok, true);
});

test('a code held by a dead connection is handed over', () => {
  // device-1 registered and its connection died without a close frame, so the
  // entry is still here while nothing is listening behind it.
  const devices = withConnected([]);
  devices.register(base);

  const result = devices.register({ ...base, id: 'device-2' });

  // Refusing would retire the code until the server restarts, and the CLI treats
  // the refusal as fatal, so the user could never pair with that link.
  assert.equal(result.ok, true);
  assert.equal(devices.findByCode('ABCDEFGH')?.id, 'device-2');
});

test('the dead holder of a code is forgotten', () => {
  const devices = withConnected([]);
  devices.register(base);
  devices.register({ ...base, id: 'device-2' });

  // Leaving the old row behind would keep answering lookups for a device that no
  // longer owns anything.
  assert.equal(devices.findById('device-1'), undefined);
  assert.equal(devices.count(), 1);
});

test('a live holder still keeps its code', () => {
  const devices = withConnected(['device-1']);
  devices.register(base);

  const result = devices.register({ ...base, id: 'device-2' });

  // A running session owns its code, so handing it over would let a stranger
  // take the code shown in somebody else's terminal.
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'code_taken');
  assert.equal(devices.findByCode('ABCDEFGH')?.id, 'device-1');
});

test('a paired code is not handed over when its holder dies', () => {
  const devices = withConnected([]);
  devices.register(base);
  devices.markPaired('device-1');

  const result = devices.register({ ...base, id: 'device-2' });

  // The stale holder is evicted, so registering succeeds, but the code must not
  // become claimable again: it is single use.
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.device.paired : true, false);
});

test('a restart in the same workspace gets a fresh code', () => {
  // Same device id, new code, and the previous connection is gone: this is a
  // restart, not a second agent.
  const devices = withConnected([]);
  devices.register(base);

  const result = devices.register({ ...base, code: 'ZZZZZZZZ' });

  assert.equal(result.ok, true);
  // The old code died with its session and must not keep answering lookups.
  assert.equal(devices.findByCode('ABCDEFGH'), undefined);
  assert.equal(devices.findByCode('ZZZZZZZZ')?.id, 'device-1');
  assert.equal(devices.count(), 1);
});

test('a restart does not inherit the paired flag', () => {
  const devices = withConnected([]);
  devices.register(base);
  devices.markPaired('device-1');

  const result = devices.register({ ...base, code: 'ZZZZZZZZ' });

  // The new code has never been paired, so carrying the flag over would leave the
  // fresh session unable to pair at all.
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.device.paired : true, false);
});

test('a live agent still holds its workspace', () => {
  const devices = withConnected(['device-1']);
  devices.register(base);

  const result = devices.register({ ...base, code: 'ZZZZZZZZ' });

  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.reason, 'workspace_busy');
});
