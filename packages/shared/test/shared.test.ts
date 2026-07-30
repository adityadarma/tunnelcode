import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAME, isRecord } from '../dist/index.js';

test('the app name is stable', () => {
  // Used in output and in config paths, so a change here is a breaking change.
  assert.equal(APP_NAME, 'tunnelcode');
});

test('a plain object is a record', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ version: '1.0.0' }), true);
});

test('null is not a record', () => {
  // typeof null is "object", which is the trap this guard exists for.
  assert.equal(isRecord(null), false);
});

test('an array is not a record', () => {
  // Parsed JSON can be an array, and treating it as a record would read
  // properties that are not there.
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([1, 2]), false);
});

test('primitives are not records', () => {
  assert.equal(isRecord('text'), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(true), false);
  assert.equal(isRecord(undefined), false);
});

test('a narrowed value can be read safely', () => {
  const parsed: unknown = JSON.parse('{"version":"0.1.0"}');

  assert.equal(isRecord(parsed) && parsed['version'], '0.1.0');
});
