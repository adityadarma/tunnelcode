import {
  ConfigError,
  globalConfigPath,
  loadGlobalConfig,
  loadWorkspaceConfig,
  mergeConfig,
  workspaceConfigPath,
} from '@remotecode/config';
import type { GlobalConfig, WorkspaceConfig } from '@remotecode/config';
import { ENGINE_NAMES, createEngine } from '@remotecode/engine';
import { writeOut } from '../output.js';

const REQUIRED_NODE_MAJOR = 22;

interface CheckResult<T> {
  value: T | undefined;
  status: string;
  failed: boolean;
}

/**
 * Runs one config check without throwing, so doctor can report the state of
 * every file even when an earlier one is broken.
 */
async function check<T>(load: () => Promise<T | undefined>): Promise<CheckResult<T>> {
  try {
    const value = await load();
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
 * runtime plus a usable global config, since without it there is no server to
 * reach.
 */
export async function runDoctor(): Promise<number> {
  const cwd = process.cwd();
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodeOk = major >= REQUIRED_NODE_MAJOR;
  const nodeStatus = nodeOk ? 'ok' : `needs >= ${String(REQUIRED_NODE_MAJOR)}`;

  const global: CheckResult<GlobalConfig> = await check(loadGlobalConfig);
  const workspace: CheckResult<WorkspaceConfig> = await check(() => loadWorkspaceConfig(cwd));

  writeOut('remotecode doctor');
  writeOut('');
  writeOut(`platform   ${process.platform} ${process.arch}`);
  writeOut(`node       ${process.versions.node} ${nodeStatus}`);
  writeOut(`global     ${globalConfigPath()}`);
  writeOut(`           ${global.status}`);
  writeOut(`workspace  ${workspaceConfigPath(cwd)}`);
  writeOut(`           ${workspace.status}`);

  let engineOk = false;

  if (global.value !== undefined && !workspace.failed) {
    const resolved = mergeConfig(global.value, workspace.value);
    const engine = createEngine(resolved.engine);

    writeOut('');
    writeOut(`server     ${resolved.serverUrl}`);
    writeOut(`device     ${resolved.deviceName}`);

    if (engine === undefined) {
      writeOut(`engine     ${resolved.engine} unknown`);
      writeOut(`           available: ${ENGINE_NAMES.join(', ')}`);
    } else {
      engineOk = await engine.isAvailable();
      writeOut(
        `engine     ${engine.name} (${engine.command}) ${engineOk ? 'ok' : 'not found on PATH'}`,
      );
    }
  }

  if (global.value === undefined && !global.failed) {
    writeOut('');
    writeOut('No global config found. Run remotecode setup first.');
  }

  const configOk = global.value !== undefined && !workspace.failed;
  return nodeOk && configOk && engineOk ? 0 : 1;
}
