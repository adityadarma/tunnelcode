import { ConfigError, globalConfigPath, loadGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, createEngine } from '@tunnelcode/engine';
import { writeOut } from '../output.js';
import { bold, cyanBold, green, red, yellow } from '../style.js';

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
  const config = await check();

  const okIcon = green('✔');
  const errIcon = red('✖');

  writeOut('');
  writeOut(cyanBold('┌── Environment Diagnostics ──────────────────────┐'));
  writeOut(cyanBold('│'));

  writeOut(
    `  ${nodeOk ? okIcon : errIcon} ${bold('platform')}   ${process.platform} ${process.arch}`,
  );
  writeOut(
    `  ${nodeOk ? okIcon : errIcon} ${bold('node')}       ${process.versions.node} ${
      nodeOk ? green('ok') : red(`needs >= ${String(REQUIRED_NODE_MAJOR)}`)
    }`,
  );
  writeOut(`  ${okIcon} ${bold('workspace')}  ${process.cwd()}`);
  writeOut(
    `  ${!config.failed ? okIcon : errIcon} ${bold('config')}     ${globalConfigPath()} ${
      config.status === 'ok' ? green('ok') : yellow(config.status)
    }`,
  );

  let engineOk = false;

  if (config.value !== undefined) {
    const engine = createEngine(config.value.engine);

    writeOut(cyanBold('│'));
    writeOut(`  ${okIcon} ${bold('server')}     ${config.value.server.url}`);
    writeOut(`  ${okIcon} ${bold('device')}     ${config.value.device.name}`);

    if (engine === undefined) {
      writeOut(
        `  ${errIcon} ${bold('engine')}     ${red(config.value.engine)} (unknown, available: ${ENGINE_NAMES.join(', ')})`,
      );
    } else {
      engineOk = await engine.isAvailable();
      writeOut(
        `  ${engineOk ? okIcon : errIcon} ${bold('engine')}     ${engine.name} (${engine.command}) ${
          engineOk ? green('ok') : red('not found on PATH')
        }`,
      );
    }
  }

  writeOut(cyanBold('└─────────────────────────────────────────────────┘'));

  if (config.value === undefined && !config.failed) {
    writeOut('');
    writeOut(yellow('  No configuration yet. Choose a setting above to create it.'));
  }

  return nodeOk && config.value !== undefined && engineOk ? 0 : 1;
}
