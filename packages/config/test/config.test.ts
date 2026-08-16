import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ConfigError } from '../dist/error.js';
import { loadGlobalConfig } from '../dist/load.js';
import { globalConfigPath } from '../dist/paths.js';
import { writeGlobalConfig } from '../dist/write.js';
import { withTempHome } from './helpers.ts';

/**
 * A config that has chosen no engine, which is what a first run writes.
 *
 * Absent rather than named, because which engines a machine has cannot be known
 * without looking for them. See ADR-056.
 */
const configWithoutEngine = {
  server: { url: 'https://rc.example.com' },
  device: { name: 'Test Mac' },
  // Timeouts have defaults, so a loaded config always carries them even when the
  // file on disk says nothing about them.
  timeouts: { idleMinutes: 60, answerMinutes: 5, silenceMinutes: 15 },
  // The ceiling has a default, so a loaded config always carries one even when the
  // file on disk says nothing about it. See ADR-022.
  permission: { deny: [] },
};

const validConfig = { ...configWithoutEngine, engine: 'opencode' };

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

test('a config that names no engine loads with none', async () => {
  await withTempHome(async () => {
    await writeRaw(JSON.stringify({ server: validConfig.server, device: validConfig.device }));

    // Which engines exist on a machine cannot be known without looking, so a first
    // run writes no engine and the first installed one leads. See ADR-056.
    const loaded = await loadGlobalConfig();

    assert.equal(loaded?.engine, undefined);
    assert.deepEqual(loaded?.server, validConfig.server);
  });
});

test('an engine chosen later is stored on its own', async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(configWithoutEngine);
    await writeGlobalConfig({ ...configWithoutEngine, engine: 'claude' });

    // Absent is what nothing chosen looks like, so choosing has to be the thing
    // that puts a name in the file.
    assert.equal((await loadGlobalConfig())?.engine, 'claude');
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
    const path = await writeRaw(
      JSON.stringify({
        server: validConfig.server,
        device: validConfig.device,
        defaultEngine: 'claude',
      }),
    );

    // `engine` is the only name, and it has to be refused rather than skipped now
    // that it is optional: parsed as a config that chose nothing, this file would
    // load clean and start conversations on whatever is installed first, dropping a
    // choice the user did make while reporting success. See ADR-056.
    await assert.rejects(
      () => loadGlobalConfig(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.path, path);
        assert.match(error.message, /defaultEngine/);
        return true;
      },
    );
  });
});

test('an unknown key alongside a valid engine is ignored', async () => {
  await withTempHome(async () => {
    await writeRaw(
      JSON.stringify({
        server: validConfig.server,
        device: validConfig.device,
        engine: 'claude',
        somethingElse: 'ignored',
      }),
    );

    // Only the one name a released build actually wrote is refused. A stray key that
    // has never been the engine's name is not a choice being dropped.
    assert.equal((await loadGlobalConfig())?.engine, 'claude');
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
