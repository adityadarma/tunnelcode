import { ConfigError, globalConfigPath, loadGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, discoverEngines } from '@tunnelcode/engine';
import { writeOut } from '../output.js';
import { bold, cyanBold, dim, green, red, yellow } from '../style.js';

/**
 * Oldest Node the CLI is supported on, as [major, minor].
 *
 * The minor matters: 22.18 is where Node runs TypeScript without a flag, which is
 * what the test runner relies on, and where `node:sqlite` is present for reading
 * an engine's own session files. An earlier 22 satisfies a bare `>=22` while
 * failing both, so the check cannot compare majors alone.
 */
const REQUIRED_NODE: readonly [number, number] = [22, 18];

function formatRequiredNode(): string {
  return `${String(REQUIRED_NODE[0])}.${String(REQUIRED_NODE[1])}`;
}

/**
 * Whether the running Node is at or above the supported floor. An unparseable
 * version counts as too old rather than being waved through, since a runtime that
 * cannot say what it is cannot be vouched for.
 */
function nodeIsSupported(version: string): boolean {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));

  if (major === undefined || Number.isNaN(major)) {
    return false;
  }

  if (major !== REQUIRED_NODE[0]) {
    return major > REQUIRED_NODE[0];
  }

  return minor !== undefined && !Number.isNaN(minor) && minor >= REQUIRED_NODE[1];
}

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
  const nodeOk = nodeIsSupported(process.versions.node);
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
      nodeOk ? green('ok') : red(`needs >= ${formatRequiredNode()}`)
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

    // What a new conversation actually starts on: the configured engine when it is
    // installed, otherwise the first one found. Marked from that rather than from
    // the stored name, so the label is right on a machine that has chosen nothing.
    const leading = installed.find((engine) => engine.name === stored.engine) ?? installed[0];

    for (const name of ENGINE_NAMES) {
      const found = installed.find((engine) => engine.name === name);
      const label = name === leading?.name ? `${name} ${dim('(default)')}` : name;

      writeOut(
        found === undefined
          ? `  ${errIcon} ${bold('engine')}     ${label} ${red('not found on PATH')}`
          : `  ${okIcon} ${bold('engine')}     ${label} (${found.command}) ${green('ok')}${
              found.models.length === 0 ? ` ${dim('no models reported')}` : ''
            }`,
      );
    }

    // The configured engine is only a starting point now, so a missing one is worth
    // saying without failing the check. Nothing is said when none is configured:
    // there is no choice being ignored, and the marked engine already says which
    // one leads. See ADR-056.
    if (engineOk && stored.engine !== undefined && stored.engine !== leading?.name) {
      writeOut(
        `  ${okIcon} ${bold('default')}    ${yellow(
          `${stored.engine} is not installed, new conversations start on ${leading?.name ?? ''}`,
        )}`,
      );
    }
  }

  writeOut(cyanBold('└─────────────────────────────────────────────────┘'));

  // Doctor reports and never writes, so a missing file is said rather than filled
  // in here. It is not a problem to fix: the first session writes the default. See
  // ADR-056.
  if (config.value === undefined && !config.failed) {
    writeOut('');
    writeOut(yellow('  No file yet. The default is written when you first scan the QR.'));
  }

  return nodeOk && config.value !== undefined && engineOk ? 0 : 1;
}
