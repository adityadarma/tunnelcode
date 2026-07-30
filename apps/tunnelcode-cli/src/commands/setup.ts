import { hostname } from 'node:os';
import {
  ConfigError,
  globalConfigPath,
  loadGlobalConfig,
  writeGlobalConfig,
} from '@tunnelcode/config';
import { ENGINE_NAMES, isEngineName } from '@tunnelcode/engine';
import { writeErr, writeOut } from '../output.js';
import { resolveDefaultServerUrl } from '../server-url.js';

const DEFAULT_ENGINE = 'opencode';

interface SetupOptions {
  serverUrl?: string;
  deviceName?: string;
  engine?: string;
  force: boolean;
}

/**
 * Creates the global configuration for this machine. Refuses to overwrite an
 * existing config unless --force is given, so a stray setup cannot silently
 * discard a working server URL.
 */
export async function runSetup(options: SetupOptions): Promise<number> {
  const path = globalConfigPath();
  const engine = options.engine ?? DEFAULT_ENGINE;

  if (!isEngineName(engine)) {
    writeErr(`Unknown engine: ${engine}`);
    writeErr(`Available engines: ${ENGINE_NAMES.join(', ')}`);
    return 1;
  }

  try {
    const existing = await loadGlobalConfig();

    if (existing !== undefined && !options.force) {
      writeOut('tunnelcode setup');
      writeOut('');
      writeOut(`Global config already exists at ${path}`);
      writeOut('Run tunnelcode setup --force to overwrite it.');
      return 0;
    }

    const written = await writeGlobalConfig({
      server: { url: options.serverUrl ?? resolveDefaultServerUrl() },
      device: { name: options.deviceName ?? hostname() },
      defaultEngine: engine,
    });

    writeOut('tunnelcode setup');
    writeOut('');
    writeOut(`Wrote global config to ${written}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      writeErr(`${error.path}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
