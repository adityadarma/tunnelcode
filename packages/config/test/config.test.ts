import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError } from '../dist/error.js';
import { loadGlobalConfig, loadWorkspaceConfig } from '../dist/load.js';
import { globalConfigPath, workspaceConfigPath } from '../dist/paths.js';
import { writeGlobalConfig, writeWorkspaceConfig } from '../dist/write.js';
import { mergeConfig } from '../dist/merge.js';
import { withTempDir, withTempHome } from './helpers.ts';

const validGlobal = {
  server: { url: 'https://rc.example.com' },
  device: { name: 'Test Mac' },
  defaultEngine: 'opencode',
};

test('a missing config is not an error', async () => {
  await withTempHome(async () => {
    assert.equal(await loadGlobalConfig(), undefined);
  });
});

test('a written global config reads back unchanged', async () => {
  await withTempHome(async () => {
    const path = await writeGlobalConfig(validGlobal);

    assert.equal(path, globalConfigPath());
    assert.deepEqual(await loadGlobalConfig(), validGlobal);
  });
});

test('the writer creates missing directories', async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(validGlobal);
    assert.notEqual(await loadGlobalConfig(), undefined);
  });
});

test('broken json is reported with its path', async () => {
  await withTempHome(async () => {
    const path = globalConfigPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');

    await assert.rejects(
      () => loadGlobalConfig(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.path, path);
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
  });
});

test('an invalid server url is rejected', async () => {
  await withTempHome(async () => {
    const path = globalConfigPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...validGlobal, server: { url: 'not-a-url' } }), 'utf8');

    await assert.rejects(() => loadGlobalConfig(), ConfigError);
  });
});

test('an empty engine name is rejected', async () => {
  await withTempHome(async () => {
    await withTempDir(async (dir) => {
      const path = workspaceConfigPath(dir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ engine: '' }), 'utf8');

      await assert.rejects(() => loadWorkspaceConfig(dir), ConfigError);
    });
  });
});

test('a written workspace config reads back unchanged', async () => {
  await withTempDir(async (dir) => {
    const path = await writeWorkspaceConfig(dir, { engine: 'claude' });

    assert.equal(path, workspaceConfigPath(dir));
    assert.deepEqual(await loadWorkspaceConfig(dir), { engine: 'claude' });
  });
});

test('the workspace engine overrides the global default', () => {
  const resolved = mergeConfig(validGlobal, { engine: 'claude' });

  assert.equal(resolved.engine, 'claude');
  // Server and device stay machine wide, only the engine is per workspace.
  assert.equal(resolved.serverUrl, 'https://rc.example.com');
  assert.equal(resolved.deviceName, 'Test Mac');
});

test('without a workspace config the global default engine is used', () => {
  assert.equal(mergeConfig(validGlobal, undefined).engine, 'opencode');
});
