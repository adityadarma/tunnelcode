import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Installs a fake engine executable on PATH for the duration of a test.
 *
 * Real engines call a paid API and take seconds to answer, so the adapters are
 * verified against recorded output shapes instead.
 *
 * On Windows the fake is a .cmd shim that hands the script to node, because a
 * shebang means nothing there and Node will not execute a script by name. That is
 * also how npm installs a real CLI on Windows, so the lookup and the launch take the
 * same path through cmd.exe that a real engine would.
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

/** Removes a command from PATH, so "not installed" can be tested. */
export async function withEmptyPath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env['PATH'] ?? '';
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-empty-'));

  // Keeps the system tools the lookup itself needs, without any engine. The
  // running Node is kept too: a fake engine is a script run by node, so without it
  // a fake installed inside this helper could be found but not run.
  //
  // On Windows System32 is what holds where.exe, which is the lookup itself, so
  // dropping it would report every engine as missing for the wrong reason.
  const system = isWindows
    ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];

  process.env['PATH'] = [dir, dirname(process.execPath), ...system].join(delimiter);

  try {
    return await run();
  } finally {
    process.env['PATH'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
