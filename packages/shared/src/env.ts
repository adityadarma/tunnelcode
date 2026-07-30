import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

const ENV_FILE = '.env';

/**
 * Loads a .env file if one exists.
 *
 * Node does not read .env on its own, so without this the file is silently
 * ignored. Values already present in the real environment are left alone, which
 * keeps `PORT=8080 pnpm start` working even when .env says something else.
 *
 * The search walks upward from the working directory, because a workspace command
 * runs inside its own package while the .env usually sits at the repository root.
 *
 * Returns the file that was loaded, or undefined when there is none.
 */
export function loadEnvFile(startDir = process.cwd()): string | undefined {
  const explicit = process.env['ENV_FILE'];

  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      return undefined;
    }

    process.loadEnvFile(explicit);
    return explicit;
  }

  const root = parse(startDir).root;
  let current = startDir;

  for (;;) {
    const candidate = join(current, ENV_FILE);

    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}
