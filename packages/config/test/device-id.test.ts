import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { machineIdPath, readOrCreateDeviceId } from '../dist/device-id.js';
import { withTempHome } from './helpers.ts';

test('the device id is stable across calls', async () => {
  await withTempHome(async () => {
    const first = await readOrCreateDeviceId('/work/project');
    const second = await readOrCreateDeviceId('/work/project');

    // Sessions in the database point at a device, so a new id on every run would
    // leave every earlier session permanently offline.
    assert.equal(first, second);
  });
});

test('different workspaces get different device ids', async () => {
  await withTempHome(async () => {
    const a = await readOrCreateDeviceId('/work/alpha');
    const b = await readOrCreateDeviceId('/work/beta');

    // Two agents in different directories have their own engine and files, so
    // prompts must never be routed between them.
    assert.notEqual(a, b);
  });
});

test('the device id looks like a uuid', async () => {
  await withTempHome(async () => {
    const id = await readOrCreateDeviceId('/work/project');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

test('the machine id is written once and reused', async () => {
  await withTempHome(async () => {
    await readOrCreateDeviceId('/work/project');
    const stored = (await readFile(machineIdPath(), 'utf8')).trim();

    await readOrCreateDeviceId('/work/other');
    assert.equal((await readFile(machineIdPath(), 'utf8')).trim(), stored);
  });
});

test('a different machine id yields a different device id', async () => {
  const first = await withTempHome(async () => readOrCreateDeviceId('/work/project'));
  const second = await withTempHome(async () => readOrCreateDeviceId('/work/project'));

  // Same workspace path, different machine: these are different devices.
  assert.notEqual(first, second);
});
