import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Creates an isolated HOME for a test.
 *
 * The config loader resolves paths from the home directory, so without this a
 * test would read and overwrite the developer's own global config.
 */
export async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env['HOME'];
  const previousAppData = process.env['APPDATA'];
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-test-'));

  process.env['HOME'] = home;
  process.env['APPDATA'] = join(home, 'AppData', 'Roaming');

  try {
    return await run(home);
  } finally {
    if (previous === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = previous;
    }

    if (previousAppData === undefined) {
      delete process.env['APPDATA'];
    } else {
      process.env['APPDATA'] = previousAppData;
    }

    await rm(home, { recursive: true, force: true });
  }
}

/** Creates an isolated workspace directory for a test. */
export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-ws-'));

  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
