import { loadGlobalConfig, readOrCreateDeviceId } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, createEngine } from '@tunnelcode/engine';
import type { Engine } from '@tunnelcode/engine';
import { runPairingSession } from '../pairing/session.js';
import { writeErr, writeOut } from '../output.js';

/**
 * Configuration and engine the agent needs, or undefined when something is
 * missing. The reason is printed here, because the caller only has to decide
 * whether to return to the menu.
 */
interface Ready {
  config: GlobalConfig;
  engine: Engine;
}

/**
 * Resolves what a session needs: a stored config plus an engine on PATH.
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

  const engine = createEngine(config.engine);

  if (engine === undefined) {
    writeErr(`Unknown engine: ${config.engine}`);
    writeErr(`Available engines: ${ENGINE_NAMES.join(', ')}`);
    writeErr('Choose Setup to pick a different one.');
    return undefined;
  }

  writeOut('');
  writeOut(`workspace  ${cwd}`);
  writeOut(`server     ${config.server.url}`);
  writeOut(`device     ${config.device.name}`);

  const available = await engine.isAvailable();

  writeOut(
    `engine     ${engine.name} (${engine.command}) ${available ? 'ok' : 'not found on PATH'}`,
  );
  writeOut('');

  if (!available) {
    writeErr(
      `Cannot find ${engine.command} on PATH. Install it or choose another engine in Setup.`,
    );
    return undefined;
  }

  return { config, engine };
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

  // Asked once at startup, since the browser may only pick from what the engine
  // chosen here can actually serve.
  const models = await ready.engine.listModels();

  return runPairingSession({
    serverUrl: ready.config.server.url,
    deviceId: await readOrCreateDeviceId(cwd),
    deviceName: ready.config.device.name,
    workspace: cwd,
    engine: ready.engine,
    models,
  });
}
