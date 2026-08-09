import { ConfigError, globalConfigPath, loadGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, discoverEngines } from '@tunnelcode/engine';
import { writeOut } from '../output.js';
import { bold, cyanBold, dim, green, red, yellow } from '../style.js';

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

  const stored = config.value;

  if (stored !== undefined) {
    writeOut(cyanBold('│'));
    writeOut(`  ${okIcon} ${bold('server')}     ${stored.server.url}`);
    writeOut(`  ${okIcon} ${bold('device')}     ${stored.device.name}`);

    // Every supported engine is reported, not just the configured one: a session
    // runs as long as one is installed, and the browser chooses per conversation.
    // See ADR-020.
    const installed = await discoverEngines();
    engineOk = installed.length > 0;

    for (const name of ENGINE_NAMES) {
      const found = installed.find((engine) => engine.name === name);
      const label = name === stored.engine ? `${name} ${dim('(default)')}` : name;

      writeOut(
        found === undefined
          ? `  ${errIcon} ${bold('engine')}     ${label} ${red('not found on PATH')}`
          : `  ${okIcon} ${bold('engine')}     ${label} (${found.command}) ${green('ok')}${
              found.models.length === 0 ? ` ${dim('no models reported')}` : ''
            }`,
      );
    }

    // The configured engine is only a starting point now, so a missing one is worth
    // saying without failing the check.
    if (engineOk && !installed.some((engine) => engine.name === stored.engine)) {
      writeOut(
        `  ${okIcon} ${bold('default')}    ${yellow(
          `${stored.engine} is not installed, new conversations start on ${installed[0]?.name ?? ''}`,
        )}`,
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
