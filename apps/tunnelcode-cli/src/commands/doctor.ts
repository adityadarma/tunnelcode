import { ConfigError, globalConfigPath, loadGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, createEngine } from '@tunnelcode/engine';
import { writeOut } from '../output.js';

const REQUIRED_NODE_MAJOR = 22;

interface CheckResult {
  value: GlobalConfig | undefined;
  status: string;
  failed: boolean;
}

/**
 * Loads the config without throwing, so doctor can report a broken file as a
 * status rather than ending the menu with an error.
 */
async function check(): Promise<CheckResult> {
  try {
    const value = await loadGlobalConfig();
    return {
      value,
      status: value === undefined ? 'missing' : 'ok',
      failed: false,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { value: undefined, status: error.message, failed: true };
    }
    throw error;
  }
}

/**
 * Validates that the local environment can run the agent: a supported Node
 * runtime plus a usable config, since without it there is no server to reach.
 */
export async function runDoctor(): Promise<number> {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodeOk = major >= REQUIRED_NODE_MAJOR;
  const nodeStatus = nodeOk ? 'ok' : `needs >= ${String(REQUIRED_NODE_MAJOR)}`;

  const config = await check();

  writeOut('');
  writeOut(`platform   ${process.platform} ${process.arch}`);
  writeOut(`node       ${process.versions.node} ${nodeStatus}`);
  writeOut(`workspace  ${process.cwd()}`);
  writeOut(`config     ${globalConfigPath()}`);
  writeOut(`           ${config.status}`);

  let engineOk = false;

  if (config.value !== undefined) {
    const engine = createEngine(config.value.engine);

    writeOut('');
    writeOut(`server     ${config.value.server.url}`);
    writeOut(`device     ${config.value.device.name}`);

    if (engine === undefined) {
      writeOut(`engine     ${config.value.engine} unknown`);
      writeOut(`           available: ${ENGINE_NAMES.join(', ')}`);
    } else {
      engineOk = await engine.isAvailable();
      writeOut(
        `engine     ${engine.name} (${engine.command}) ${engineOk ? 'ok' : 'not found on PATH'}`,
      );
    }
  }

  if (config.value === undefined && !config.failed) {
    writeOut('');
    writeOut('No configuration yet. Choose a setting above to create it.');
  }

  return nodeOk && config.value !== undefined && engineOk ? 0 : 1;
}
