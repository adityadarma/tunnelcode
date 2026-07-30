import { hostname } from 'node:os';
import { globalConfigPath, loadGlobalConfig, writeGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES } from '@tunnelcode/engine';
import type { EngineName } from '@tunnelcode/engine';
import { runDoctor } from './doctor.js';
import { CANCELLED, ask, select } from '../prompt.js';
import type { Choice } from '../prompt.js';
import { writeErr, writeOut } from '../output.js';
import { resolveDefaultServerUrl } from '../server-url.js';

const DEFAULT_ENGINE: EngineName = 'opencode';

type Field = 'server' | 'device' | 'engine' | 'doctor' | 'back';

/**
 * Configuration as the menu should offer it: what is stored, or the default that
 * would be stored. A field is never asked for without showing what it is now.
 */
function draftFrom(stored: GlobalConfig | undefined): GlobalConfig {
  return (
    stored ?? {
      server: { url: resolveDefaultServerUrl() },
      device: { name: hostname() },
      engine: DEFAULT_ENGINE,
    }
  );
}

/**
 * Rejects anything that is not an http(s) URL.
 *
 * The value becomes the address the agent connects to, so a typo that parses as
 * some other scheme would fail later with a much less obvious message.
 */
function validateServerUrl(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return 'That is not a URL. Include the scheme, for example http://localhost:3000';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The URL must start with http:// or https://';
  }

  return undefined;
}

async function editServerUrl(draft: GlobalConfig): Promise<void> {
  const answer = await ask({ label: 'Server URL', current: draft.server.url });

  if (answer === CANCELLED) {
    return;
  }

  const problem = validateServerUrl(answer);

  if (problem !== undefined) {
    writeErr(problem);
    return;
  }

  await writeGlobalConfig({ ...draft, server: { url: answer } });
  writeOut(`Server URL set to ${answer}`);
}

async function editDeviceName(draft: GlobalConfig): Promise<void> {
  const answer = await ask({ label: 'Device name', current: draft.device.name });

  if (answer === CANCELLED) {
    return;
  }

  await writeGlobalConfig({ ...draft, device: { name: answer } });
  writeOut(`Device name set to ${answer}`);
}

async function editEngine(draft: GlobalConfig): Promise<void> {
  // The current one is marked, so the choice is never blind.
  const choices: Choice<EngineName>[] = ENGINE_NAMES.map((name) => ({
    value: name,
    label: name,
    ...(name === draft.engine ? { hint: '(current)' } : {}),
  }));

  const choice = await select('Engine', choices);

  if (choice === CANCELLED) {
    return;
  }

  await writeGlobalConfig({ ...draft, engine: choice });
  writeOut(`Engine set to ${choice}`);
}

/**
 * Runs the settings menu until the user goes back.
 *
 * Every field is written as soon as it is answered, so leaving the menu at any
 * point never discards a change the user already confirmed.
 */
export async function runSetupMenu(): Promise<void> {
  for (;;) {
    const stored = await loadGlobalConfig();
    const draft = draftFrom(stored);

    const choice = await select('Setup', [
      { value: 'server', label: 'Server URL', hint: draft.server.url },
      { value: 'device', label: 'Device name', hint: draft.device.name },
      { value: 'engine', label: 'Engine', hint: draft.engine },
      { value: 'doctor', label: 'Check environment' },
      { value: 'back', label: 'Back' },
    ] satisfies Choice<Field>[]);

    if (choice === CANCELLED || choice === 'back') {
      return;
    }

    switch (choice) {
      case 'server':
        await editServerUrl(draft);
        break;
      case 'device':
        await editDeviceName(draft);
        break;
      case 'engine':
        await editEngine(draft);
        break;
      case 'doctor':
        await runDoctor();
        break;
    }

    // Written on the first change, so a first run leaves a complete config
    // behind rather than only the field that was touched.
    if (stored === undefined) {
      writeOut('');
      writeOut(`Configuration stored at ${globalConfigPath()}`);
    }
  }
}
