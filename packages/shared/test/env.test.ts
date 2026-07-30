import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../dist/index.js';

/** Runs with a given environment, restoring it afterwards. */
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

async function withTempTree<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'remotecode-env-'));

  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const clean = { HOST: undefined, PORT: undefined, ENV_FILE: undefined };

test('a .env file in the working directory is loaded', async () => {
  await withTempTree(async (dir) => {
    await writeFile(join(dir, '.env'), 'HOST=10.0.0.5\nPORT=8080\n', 'utf8');

    await withEnv(clean, async () => {
      const loaded = loadEnvFile(dir);

      assert.equal(loaded, join(dir, '.env'));
      assert.equal(process.env['HOST'], '10.0.0.5');
      assert.equal(process.env['PORT'], '8080');
    });
  });
});

test('a .env higher up the tree is found', async () => {
  await withTempTree(async (dir) => {
    const nested = join(dir, 'apps', 'remotecode-server');
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir, '.env'), 'HOST=10.0.0.9\n', 'utf8');

    await withEnv(clean, async () => {
      // A workspace command runs inside its own package, while the .env usually
      // sits at the repository root.
      assert.equal(loadEnvFile(nested), join(dir, '.env'));
      assert.equal(process.env['HOST'], '10.0.0.9');
    });
  });
});

test('a real environment variable wins over the file', async () => {
  await withTempTree(async (dir) => {
    await writeFile(join(dir, '.env'), 'HOST=10.0.0.5\n', 'utf8');

    await withEnv({ ...clean, HOST: '192.168.1.1' }, async () => {
      loadEnvFile(dir);

      // Otherwise `HOST=x pnpm start` would be silently ignored.
      assert.equal(process.env['HOST'], '192.168.1.1');
    });
  });
});

test('no .env file is not an error', async () => {
  await withTempTree(async (dir) => {
    await withEnv(clean, async () => {
      assert.equal(loadEnvFile(dir), undefined);
      assert.equal(process.env['HOST'], undefined);
    });
  });
});

test('ENV_FILE points at a specific file', async () => {
  await withTempTree(async (dir) => {
    const custom = join(dir, 'production.env');
    await writeFile(custom, 'HOST=10.1.1.1\n', 'utf8');
    await writeFile(join(dir, '.env'), 'HOST=10.9.9.9\n', 'utf8');

    await withEnv({ ...clean, ENV_FILE: custom }, async () => {
      assert.equal(loadEnvFile(dir), custom);
      // The named file wins, the nearby .env is not consulted.
      assert.equal(process.env['HOST'], '10.1.1.1');
    });
  });
});

test('a missing ENV_FILE is reported as not loaded', async () => {
  await withTempTree(async (dir) => {
    await withEnv({ ...clean, ENV_FILE: join(dir, 'absent.env') }, async () => {
      assert.equal(loadEnvFile(dir), undefined);
    });
  });
});
