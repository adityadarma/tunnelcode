import { globalConfigPath, loadGlobalConfig, writeGlobalConfig } from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { resolveDefaultDeviceName } from './device-name.js';
import { resolveDefaultServerUrl } from './server-url.js';

/** Minutes without conversation before the session ends. */
export const DEFAULT_IDLE_MINUTES = 60;
/** Minutes a tool-run approval waits before being auto-refused. */
export const DEFAULT_ANSWER_MINUTES = 5;
/** Minutes without engine output before the turn is abandoned. */
export const DEFAULT_SILENCE_MINUTES = 15;

/**
 * The configuration a machine that has never been set up should run with.
 *
 * Every field here is a value this machine already carries: the server URL baked
 * in at publish time, its own name, and the timeouts the schema would have
 * defaulted to anyway. Nothing is read from the environment, so this is the same
 * file whatever shell it was started from. See ADR-018 and ADR-056.
 *
 * The device name is resolved rather than read straight off `hostname`, because a
 * hostname handed out by DHCP is an address and the phone shows this to a person.
 * See ADR-058.
 *
 * No engine is named. Which engines exist on a machine cannot be known without
 * looking for them, and a name written before looking is a preference nobody
 * expressed: it reads back from Setup as a choice, and it is wrong on every
 * machine that installed something else. The first installed engine leads until
 * somebody chooses.
 */
export function defaultConfig(): GlobalConfig {
  return {
    server: { url: resolveDefaultServerUrl() },
    device: { name: resolveDefaultDeviceName() },
    timeouts: {
      idleMinutes: DEFAULT_IDLE_MINUTES,
      answerMinutes: DEFAULT_ANSWER_MINUTES,
      silenceMinutes: DEFAULT_SILENCE_MINUTES,
    },
    permission: { deny: [] },
  };
}

/** A config that was already stored, or the default that has just been written. */
export interface EnsuredConfig {
  config: GlobalConfig;
  /** Where it lives, so a first run can say what was created. */
  path: string;
  /** True when this call wrote the file. */
  created: boolean;
}

/**
 * Resolves the config, writing the default when there is no file yet.
 *
 * A first run used to end here: the config was missing, so pairing refused and
 * pointed at Setup, and every answer Setup wanted was one this machine could
 * already make for itself. Writing the default instead means scanning the QR works
 * on a fresh install, and Setup goes back to being where a value is changed rather
 * than where it is entered for the first time.
 *
 * Only a missing file is filled in. A file that exists and does not parse still
 * raises, because guessing over something the user wrote would lose it. Nothing is
 * written when a config is already there, so this never overwrites an answer.
 */
export async function ensureGlobalConfig(): Promise<EnsuredConfig> {
  const path = globalConfigPath();
  const stored = await loadGlobalConfig();

  if (stored !== undefined) {
    return { config: stored, path, created: false };
  }

  const config = defaultConfig();
  await writeGlobalConfig(config);

  return { config, path, created: true };
}
