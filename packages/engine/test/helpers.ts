import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Installs a fake engine executable on PATH for the duration of a test.
 *
 * Real engines call a paid API and take seconds to answer, so the adapters are
 * verified against recorded output shapes instead.
 */
export async function withFakeEngine<T>(
  name: string,
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-bin-'));
  const file = join(dir, name);
  const previous = process.env['PATH'] ?? '';

  await writeFile(file, script, 'utf8');
  await chmod(file, 0o755);
  process.env['PATH'] = `${dir}:${previous}`;

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
  // running Node is kept too: a fake engine is a script with a node shebang, so
  // without it a fake installed inside this helper could be found but not run.
  process.env['PATH'] = `${dir}:${dirname(process.execPath)}:/usr/bin:/bin`;

  try {
    return await run();
  } finally {
    process.env['PATH'] = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
