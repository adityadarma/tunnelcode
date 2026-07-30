import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { globalConfigPath, loadGlobalConfig } from '@remotecode/config';
import { runSetup } from '../dist/commands/setup.js';
import { withTempHome } from './helpers.ts';

/** Runs setup with a given environment, restoring it afterwards. */
async function withEnv<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('the default server url uses localhost and port 3000', async () => {
  await withTempHome(async () => {
    await withEnv(
      { HOST: undefined, PORT: undefined, REMOTECODE_SERVER_URL: undefined },
      async () => {
        await runSetup({ force: true });

        assert.equal((await loadGlobalConfig())?.server.url, 'http://localhost:3000');
      },
    );
  });
});

test('PORT changes the default server url', async () => {
  await withTempHome(async () => {
    await withEnv({ HOST: undefined, PORT: '8080', REMOTECODE_SERVER_URL: undefined }, async () => {
      await runSetup({ force: true });

      assert.equal((await loadGlobalConfig())?.server.url, 'http://localhost:8080');
    });
  });
});

test('HOST changes the default server url', async () => {
  await withTempHome(async () => {
    await withEnv(
      { HOST: 'rc.internal', PORT: '9000', REMOTECODE_SERVER_URL: undefined },
      async () => {
        await runSetup({ force: true });

        assert.equal((await loadGlobalConfig())?.server.url, 'http://rc.internal:9000');
      },
    );
  });
});

test('a bind address of 0.0.0.0 falls back to localhost', async () => {
  await withTempHome(async () => {
    await withEnv({ HOST: '0.0.0.0', PORT: '3000', REMOTECODE_SERVER_URL: undefined }, async () => {
      await runSetup({ force: true });

      // 0.0.0.0 is a bind address, not something a client can connect to.
      assert.equal((await loadGlobalConfig())?.server.url, 'http://localhost:3000');
    });
  });
});

test('REMOTECODE_SERVER_URL wins over host and port', async () => {
  await withTempHome(async () => {
    await withEnv(
      { HOST: 'ignored', PORT: '1234', REMOTECODE_SERVER_URL: 'https://rc.example.com' },
      async () => {
        await runSetup({ force: true });

        // A remote deployment is not described by a local host and port at all.
        assert.equal((await loadGlobalConfig())?.server.url, 'https://rc.example.com');
      },
    );
  });
});

test('an explicit --server flag wins over the environment', async () => {
  await withTempHome(async () => {
    await withEnv(
      { HOST: 'env.host', PORT: '1234', REMOTECODE_SERVER_URL: 'https://env.example.com' },
      async () => {
        await runSetup({ force: true, serverUrl: 'https://flag.example.com' });

        assert.equal((await loadGlobalConfig())?.server.url, 'https://flag.example.com');
      },
    );
  });
});

test('setup writes the file it reports', async () => {
  await withTempHome(async () => {
    await runSetup({ force: true });

    // Reading the file directly proves the reported path is the real one.
    const raw = await readFile(globalConfigPath(), 'utf8');
    assert.match(raw, /"defaultEngine"/);
  });
});
