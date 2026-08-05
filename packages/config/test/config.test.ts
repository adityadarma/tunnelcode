import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError } from '../dist/error.js';
import { loadGlobalConfig } from '../dist/load.js';
import { globalConfigPath } from '../dist/paths.js';
import { writeGlobalConfig } from '../dist/write.js';
import { withTempHome } from './helpers.ts';

const validConfig = {
  server: { url: 'https://rc.example.com' },
  device: { name: 'Test Mac' },
  engine: 'opencode',
  // Timeouts have defaults, so a loaded config always carries them even when the
  // file on disk says nothing about them.
  timeouts: { idleMinutes: 60, answerMinutes: 5, silenceMinutes: 15 },
  // The ceiling has a default, so a loaded config always carries one even when the
  // file on disk says nothing about it. See ADR-022.
  permission: { deny: [] },
};

/** Writes a config file directly, bypassing validation. */
async function writeRaw(content: string): Promise<string> {
  const path = globalConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

test('a missing config is not an error', async () => {
  await withTempHome(async () => {
    assert.equal(await loadGlobalConfig(), undefined);
  });
});

test('a written config reads back unchanged', async () => {
  await withTempHome(async () => {
    const path = await writeGlobalConfig(validConfig);

    assert.equal(path, globalConfigPath());
    assert.deepEqual(await loadGlobalConfig(), validConfig);
  });
});

test('the writer creates missing directories', async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(validConfig);
    assert.notEqual(await loadGlobalConfig(), undefined);
  });
});

test('broken json is reported with its path', async () => {
  await withTempHome(async () => {
    const path = await writeRaw('{ not json');

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
    await writeRaw(JSON.stringify({ ...validConfig, server: { url: 'not-a-url' } }));

    await assert.rejects(() => loadGlobalConfig(), ConfigError);
  });
});

test('an empty engine name is rejected', async () => {
  await withTempHome(async () => {
    await writeRaw(JSON.stringify({ ...validConfig, engine: '' }));

    await assert.rejects(() => loadGlobalConfig(), ConfigError);
  });
});

test('a config missing the engine is rejected', async () => {
  await withTempHome(async () => {
    await writeRaw(JSON.stringify({ server: validConfig.server, device: validConfig.device }));

    await assert.rejects(() => loadGlobalConfig(), ConfigError);
  });
});

test('the engine name is read as written', async () => {
  await withTempHome(async () => {
    await writeRaw(
      JSON.stringify({
        server: validConfig.server,
        device: validConfig.device,
        engine: 'claude',
      }),
    );

    assert.deepEqual(await loadGlobalConfig(), { ...validConfig, engine: 'claude' });
  });
});

test('a config naming the engine anything but engine is rejected', async () => {
  await withTempHome(async () => {
    await writeRaw(
      JSON.stringify({
        server: validConfig.server,
        device: validConfig.device,
        defaultEngine: 'claude',
      }),
    );

    // `engine` is the only name. Setup rewrites the file.
    await assert.rejects(() => loadGlobalConfig(), ConfigError);
  });
});

test('a config written before the ceiling existed still loads', async () => {
  await withTempHome(async () => {
    await writeRaw(
      JSON.stringify({
        server: validConfig.server,
        device: validConfig.device,
        engine: 'opencode',
      }),
    );

    // Refusing to start over a missing field would lock every existing user out of
    // their own machine after an update.
    assert.deepEqual(await loadGlobalConfig(), validConfig);
  });
});

test('a ceiling is read back as written', async () => {
  await withTempHome(async () => {
    const deny = ['Bash(rm *)', 'WebFetch'];
    await writeGlobalConfig({ ...validConfig, permission: { deny } });

    const loaded = await loadGlobalConfig();
    assert.deepEqual(loaded?.permission.deny, deny);
  });
});
