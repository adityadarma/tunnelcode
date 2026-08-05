import { loadGlobalConfig, readOrCreateDeviceId } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, discoverEngines } from '@tunnelcode/engine';
import type { AvailableEngine } from '@tunnelcode/engine';
import { runPairingSession } from '../pairing/session.js';
import { writeErr, writeOut } from '../output.js';
import { withSpinner } from '../spinner.js';

/**
 * Configuration plus the engines this machine can run, or undefined when
 * something is missing. The reason is printed here, because the caller only has
 * to decide whether to return to the menu.
 */
interface Ready {
  config: GlobalConfig;
  engines: AvailableEngine[];
}

/**
 * Resolves what a session needs: a stored config plus at least one engine on
 * PATH.
 *
 * Every supported engine that is installed is offered, not just one, because the
 * engine is chosen per conversation in the browser. The config still names one,
 * which is the engine a new conversation starts with. See ADR-020.
 *
 * Only the stored config is read. The environment is not consulted and no
 * project directory is looked at, so the only way to change any of this is the
 * setup menu. See ADR-018 and ADR-019.
 */
async function prepare(cwd: string): Promise<Ready | undefined> {
  const config = await loadGlobalConfig();

  if (config === undefined) {
    writeErr('No configuration yet. Choose Setup first.');
    return undefined;
  }

  // Discovery asks every installed engine for its models, which spawns a process
  // each. The menu has already erased itself by now, so without something on screen
  // the terminal is blank for as long as the slowest engine takes to answer.
  const engines = await withSpinner('Generating...', () => discoverEngines());

  writeOut('');
  writeOut(`workspace  ${cwd}`);
  writeOut(`server     ${config.server.url}`);
  writeOut(`device     ${config.device.name}`);

  if (engines.length === 0) {
    writeOut(`engines    ${ENGINE_NAMES.join(', ')} (none found on PATH)`);
    writeOut('');
    writeErr(
      `Cannot find any engine on PATH. Install one of: ${ENGINE_NAMES.join(', ')}, then try again.`,
    );
    return undefined;
  }

  // The preferred one is marked, since that is what a new conversation starts
  // with unless the browser picks another.
  writeOut(
    `engines    ${engines
      .map((engine) => (engine.name === config.engine ? `${engine.name} (default)` : engine.name))
      .join(', ')}`,
  );

  // A configured engine that is not installed is worth saying out loud: the
  // session still runs, but a new conversation will start on a different one.
  if (!engines.some((engine) => engine.name === config.engine)) {
    writeOut(
      `           ${config.engine} is configured but not installed, using ${
        engines[0]?.name ?? ''
      }`,
    );
  }

  writeOut('');

  return { config, engines };
}

/**
 * Starts a pairing session for the current working directory.
 *
 * The directory is still what the agent works in, it is just no longer a place
 * configuration is read from.
 *
 * Returns the exit code, so a session that ended in a fatal error is reported as
 * one rather than dropping the user back into the menu as though nothing happened.
 */
export async function runStart(cwd: string): Promise<number> {
  const ready = await prepare(cwd);

  if (ready === undefined) {
    return 1;
  }

  // The configured engine is put first, because the browser starts a new
  // conversation on the first of the list. That keeps the Setup choice meaningful
  // without making it the only choice. A configured engine that is not installed
  // simply is not in the list, so the next installed one leads.
  const engines = [...ready.engines].sort((left, right) =>
    left.name === ready.config.engine ? -1 : right.name === ready.config.engine ? 1 : 0,
  );

  return runPairingSession({
    serverUrl: ready.config.server.url,
    deviceId: await readOrCreateDeviceId(cwd),
    deviceName: ready.config.device.name,
    workspace: cwd,
    engines,
    timeouts: {
      idleMs: ready.config.timeouts.idleMinutes * 60 * 1000,
      answerMs: ready.config.timeouts.answerMinutes * 60 * 1000,
      silenceMs: ready.config.timeouts.silenceMinutes * 60 * 1000,
    },
  });
}
