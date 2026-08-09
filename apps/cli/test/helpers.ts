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
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-cli-'));
  const undo = applyHomeEnv(home);

  try {
    return await run(home);
  } finally {
    undo();
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * The environment that points every home-relative path at one directory.
 *
 * HOME covers Linux and macOS, APPDATA is where this project's own config lives on
 * Windows, and USERPROFILE is what the home directory itself resolves from there.
 * All three, because a test that isolates only some of them writes into the
 * developer's real files on the platform it missed.
 */
export function homeEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
  };
}

/** Applies that environment to this process, returning the undo. */
function applyHomeEnv(home: string): () => void {
  const restore = Object.entries(homeEnv(home)).map(([name, value]) => {
    const previous = process.env[name];
    process.env[name] = value;

    return (): void => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    };
  });

  return () => {
    for (const step of restore) {
      step();
    }
  };
}
