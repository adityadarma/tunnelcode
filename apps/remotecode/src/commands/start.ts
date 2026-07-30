import {
  ConfigError,
  loadGlobalConfig,
  loadWorkspaceConfig,
  mergeConfig,
  readOrCreateDeviceId,
} from '@remotecode/config';
import { ENGINE_NAMES, createEngine } from '@remotecode/engine';
import type { EngineEvent } from '@remotecode/engine';
import { runPairingSession } from '../pairing/session.js';
import { serverUrlFromEnvironment } from '../server-url.js';
import { writeErr, writeOut, writeRaw } from '../output.js';

interface StartOptions {
  prompt?: string;
}

/**
 * Starts the agent for the current working directory. Config must resolve first,
 * because the agent needs a server URL and an engine before it can do anything.
 */
export async function runStart(options: StartOptions): Promise<number> {
  const cwd = process.cwd();

  try {
    const global = await loadGlobalConfig();

    if (global === undefined) {
      writeErr('No global config found. Run remotecode setup first.');
      return 1;
    }

    const workspace = await loadWorkspaceConfig(cwd);
    const merged = mergeConfig(global, workspace);

    // The environment overrides the stored server, so pointing the agent at
    // another deployment does not require rewriting the config.
    const override = serverUrlFromEnvironment();
    const resolved = override === undefined ? merged : { ...merged, serverUrl: override };
    const engine = createEngine(resolved.engine);

    if (engine === undefined) {
      writeErr(`Unknown engine: ${resolved.engine}`);
      writeErr(`Available engines: ${ENGINE_NAMES.join(', ')}`);
      return 1;
    }

    const available = await engine.isAvailable();

    writeOut('remotecode start');
    writeOut('');
    writeOut(`workspace  ${cwd}`);
    writeOut(`server     ${resolved.serverUrl}`);
    writeOut(`device     ${resolved.deviceName}`);
    writeOut(
      `engine     ${engine.name} (${engine.command}) ${available ? 'ok' : 'not found on PATH'}`,
    );
    writeOut('');

    if (!available) {
      writeErr(`Cannot find ${engine.command} on PATH. Install it or pick another engine.`);
      return 1;
    }

    // A prompt runs the engine once and exits, which is useful for checking an
    // engine without pairing a browser.
    if (options.prompt !== undefined) {
      return await streamPrompt(engine.prompt(options.prompt, { cwd }));
    }

    // Asked once at startup, since the browser may only pick from what the
    // engine chosen here can actually serve.
    const models = await engine.listModels();

    return await runPairingSession({
      serverUrl: resolved.serverUrl,
      deviceId: await readOrCreateDeviceId(cwd),
      deviceName: resolved.deviceName,
      workspace: cwd,
      engine,
      models,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      writeErr(`${error.path}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Prints engine output as it arrives. Deltas go to stdout without a trailing
 * newline so the answer reads as one continuous stream.
 */
async function streamPrompt(events: AsyncGenerator<EngineEvent>): Promise<number> {
  let failed = false;

  for await (const event of events) {
    switch (event.type) {
      case 'delta':
        writeRaw(event.text);
        break;
      case 'log':
        writeErr(event.text);
        break;
      case 'error':
        writeErr(event.message);
        failed = true;
        break;
      case 'done':
        writeOut('');
        if (event.exitCode !== 0) {
          writeErr(`Engine exited with code ${String(event.exitCode)}.`);
          failed = true;
        }
        break;
    }
  }

  return failed ? 1 : 0;
}
