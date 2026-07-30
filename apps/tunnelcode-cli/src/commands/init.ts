import {
  ConfigError,
  loadWorkspaceConfig,
  workspaceConfigPath,
  writeWorkspaceConfig,
} from '@tunnelcode/config';
import { ENGINE_NAMES, isEngineName } from '@tunnelcode/engine';
import { writeErr, writeOut } from '../output.js';

const DEFAULT_ENGINE = 'opencode';

interface InitOptions {
  engine?: string;
  force: boolean;
}

/**
 * Creates the workspace configuration in the current directory. Refuses to
 * overwrite an existing config unless --force is given.
 */
export async function runInit(options: InitOptions): Promise<number> {
  const cwd = process.cwd();
  const path = workspaceConfigPath(cwd);
  const engine = options.engine ?? DEFAULT_ENGINE;

  if (!isEngineName(engine)) {
    writeErr(`Unknown engine: ${engine}`);
    writeErr(`Available engines: ${ENGINE_NAMES.join(', ')}`);
    return 1;
  }

  try {
    const existing = await loadWorkspaceConfig(cwd);

    if (existing !== undefined && !options.force) {
      writeOut('tunnelcode init');
      writeOut('');
      writeOut(`Workspace config already exists at ${path}`);
      writeOut('Run tunnelcode init --force to overwrite it.');
      return 0;
    }

    const written = await writeWorkspaceConfig(cwd, { engine });

    writeOut('tunnelcode init');
    writeOut('');
    writeOut(`Wrote workspace config to ${written}`);
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      writeErr(`${error.path}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
