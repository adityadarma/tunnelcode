import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const isWindows = process.platform === 'win32';

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

/**
 * Installs a fake engine executable on PATH for the duration of a test.
 *
 * A real engine calls a paid API and takes seconds to answer, so discovery is
 * verified against a script that mimics its shape instead.
 *
 * On Windows the fake is a .cmd shim that hands the script to node, because a
 * shebang means nothing there and Node will not execute a script by name.
 */
export async function withFakeEngine<T>(
  name: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-bin-'));
  const previous = process.env['PATH'] ?? '';

  if (isWindows) {
    await writeFile(join(dir, `${name}.js`), script, 'utf8');
    await writeFile(join(dir, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`, 'utf8');
  } else {
    const file = join(dir, name);
    await writeFile(file, script, 'utf8');
    await chmod(file, 0o755);
  }

  process.env['PATH'] = `${dir}${delimiter}${previous}`;

  try {
    return await run();
  } finally {
    process.env['PATH'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Removes every engine from PATH, so "nothing installed" can be tested. */
export async function withEmptyPath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env['PATH'] ?? '';
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-empty-'));

  // Keeps the system tools the lookup itself needs, without any engine. The
  // running Node is kept too: a fake engine is a script run by node, so without
  // it a fake installed by withFakeEngine could be found but not run.
  const system = isWindows
    ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];

  if (isWindows) {
    await writeFile(join(dir, 'node.cmd'), `@call "${process.execPath}" %*\r\n`, 'utf8');
  } else {
    await symlink(process.execPath, join(dir, 'node'));
  }

  process.env['PATH'] = [dir, ...system].join(delimiter);

  try {
    return await run();
  } finally {
    process.env['PATH'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
