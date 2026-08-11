import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequestRegistry } from '../dist/services/pending-requests.js';

test('resolve returns the value to the waiting promise', async () => {
  const registry = new PendingRequestRegistry<string>();
  const promise = registry.create('req-1', 5000);

  registry.resolve('req-1', 'hello');

  assert.equal(await promise, 'hello');
});

test('resolve returns true when request exists', () => {
  const registry = new PendingRequestRegistry<string>();
  registry.create('req-1', 5000);

  assert.equal(registry.resolve('req-1', 'value'), true);
});

test('resolve returns false when request does not exist', () => {
  const registry = new PendingRequestRegistry<string>();

  assert.equal(registry.resolve('unknown', 'value'), false);
});

test('resolve returns false after timeout has already fired', async () => {
  const registry = new PendingRequestRegistry<string>();
  const promise = registry.create('req-1', 1);

  // Wait for the timeout to fire
  await assert.rejects(promise, { message: 'Request timed out.' });

  // Late response is silently discarded
  assert.equal(registry.resolve('req-1', 'late'), false);
});

test('create rejects with timeout error when time expires', async () => {
  const registry = new PendingRequestRegistry<string>();
  const promise = registry.create('req-1', 1);

  await assert.rejects(promise, { message: 'Request timed out.' });
});

test('rejectAll rejects every pending request', async () => {
  const registry = new PendingRequestRegistry<string>();
  const p1 = registry.create('req-1', 5000);
  const p2 = registry.create('req-2', 5000);
  const p3 = registry.create('req-3', 5000);

  const reason = new Error('Device disconnected.');
  registry.rejectAll(reason);

  await assert.rejects(p1, { message: 'Device disconnected.' });
  await assert.rejects(p2, { message: 'Device disconnected.' });
  await assert.rejects(p3, { message: 'Device disconnected.' });
});

test('rejectAll does nothing when registry is empty', () => {
  const registry = new PendingRequestRegistry<string>();

  // Should not throw
  registry.rejectAll(new Error('no-op'));
});

test('resolve after rejectAll returns false', async () => {
  const registry = new PendingRequestRegistry<string>();
  const promise = registry.create('req-1', 5000);

  registry.rejectAll(new Error('disconnected'));
  await assert.rejects(promise);

  assert.equal(registry.resolve('req-1', 'late'), false);
});
