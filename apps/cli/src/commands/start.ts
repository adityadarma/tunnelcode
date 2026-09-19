import { readOrCreateDeviceId } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES } from '@tunnelcode/engine';
import type { AvailableEngine } from '@tunnelcode/engine';
import { ensureGlobalConfig } from '../default-config.js';
import { discoverEnginesSplit } from '../engine-discovery.js';
import { runPairingSession } from '../pairing/session.js';
import { writeErr, writeOut } from '../output.js';
import { withSpinner } from '../spinner.js';
import { dim } from '../style.js';
import { readVersion } from '../version.js';

/**
 * Configuration plus the engines this machine can run, or undefined when
 * something is missing. The reason is printed here, because the caller only has
 * to decide whether to return to the menu.
 */
interface Ready {
  config: GlobalConfig;
  engines: AvailableEngine[];
  /** Resolves with the complete engine list, when discovery left some unlisted. */
  remainingEngines: Promise<AvailableEngine[]> | undefined;
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
 *
 * A machine with no config yet gets the default written for it rather than being
 * sent to Setup: every answer Setup would have asked for on a first run is one
 * this machine can already make for itself. See ADR-056.
 */
async function prepare(cwd: string): Promise<Ready | undefined> {
  const { config, path, created } = await ensureGlobalConfig();

  if (created) {
    writeOut(`${dim('[TunnelCode]')} First run, so a default configuration was written.`);
    writeOut(`${dim('[TunnelCode]')} ${path}`);
    writeOut(`  ${dim('Change any of it from Setup.')}`);
    writeOut('');
  }

  // Named for what is actually being waited on: which is on PATH, a `which` per
  // engine that answers in milliseconds. Listing models is the slow half, and an
  // engine with no fresh cache entry is left with an empty list here rather than
  // making the spinner wait for its own CLI to start. That list arrives later, as
  // an engines_updated message, once runPairingSession has something to send it on.
  const { immediate: engines, remaining: remainingEngines } = await withSpinner(
    'Checking engines...',
    () => discoverEnginesSplit(),
  );

  const version = readVersion();
  writeOut(`${dim(`[TunnelCode v${version}]`)} Initializing device...`);
  writeOut(`${dim('[TunnelCode]')} Workspace: ${cwd}`);
  writeOut('');

  if (engines.length === 0) {
    writeOut(`${dim('engines')}    ${ENGINE_NAMES.join(', ')} (none found on PATH)`);
    writeOut('');
    writeErr(
      `Cannot find any engine on PATH. Install one of: ${ENGINE_NAMES.join(', ')}, then try again.`,
    );
    return undefined;
  }

  // What a new conversation will actually start on: the configured engine when it
  // is installed, and otherwise the first one found. Marking that rather than the
  // configured name keeps the label honest on a machine that has never chosen.
  const leading = engines.find((engine) => engine.name === config.engine)?.name ?? engines[0]?.name;

  writeOut(
    `${dim('engines')}    ${engines
      .map((engine) => (engine.name === leading ? `${engine.name} (default)` : engine.name))
      .join(', ')}`,
  );

  // A configured engine that is not installed is worth saying out loud: the
  // session still runs, but a new conversation will start on a different one.
  // Nothing is said when none is configured, because then no choice was ignored.
  if (config.engine !== undefined && !engines.some((engine) => engine.name === config.engine)) {
    writeOut(`           ${config.engine} is configured but not installed, using ${leading ?? ''}`);
  }

  writeOut('');

  return { config, engines, remainingEngines };
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
  // simply is not in the list, so the next installed one leads, and a machine that
  // has chosen nothing keeps discovery order for the same reason.
  const engines = [...ready.engines].sort((left, right) =>
    left.name === ready.config.engine ? -1 : right.name === ready.config.engine ? 1 : 0,
  );

  return runPairingSession({
    serverUrl: ready.config.server.url,
    deviceId: await readOrCreateDeviceId(cwd),
    deviceName: ready.config.device.name,
    workspace: cwd,
    engines,
    ...(ready.remainingEngines === undefined ? {} : { remainingEngines: ready.remainingEngines }),
    timeouts: {
      idleMs: ready.config.timeouts.idleMinutes * 60 * 1000,
      answerMs: ready.config.timeouts.answerMinutes * 60 * 1000,
      silenceMs: ready.config.timeouts.silenceMinutes * 60 * 1000,
    },
  });
}
