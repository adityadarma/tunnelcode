import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@tunnelcode/shared';

const FALLBACK_VERSION = '0.0.0';

/**
 * Replaced at bundle time. A published bundle is a single file, so there is no
 * manifest one level up to read.
 */
declare const TUNNELCODE_BUNDLED_VERSION: string | undefined;

function bundledVersion(): string | undefined {
  // Guarded because the identifier only exists in a bundled build.
  const value =
    typeof TUNNELCODE_BUNDLED_VERSION === 'string' ? TUNNELCODE_BUNDLED_VERSION : undefined;

  return value === undefined || value === '' ? undefined : value;
}

/**
 * Reports the CLI version.
 *
 * When bundled the value is baked in; when running from a checkout it is read
 * from the manifest, so the version is never duplicated in source.
 */
export function readVersion(): string {
  const baked = bundledVersion();

  if (baked !== undefined) {
    return baked;
  }

  try {
    const manifestPath = join(import.meta.dirname, '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));

    if (isRecord(parsed) && typeof parsed['version'] === 'string') {
      return parsed['version'];
    }

    return FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
