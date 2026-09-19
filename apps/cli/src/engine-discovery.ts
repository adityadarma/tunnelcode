import { findInstalledEngines } from '@tunnelcode/engine';
import type { AvailableEngine, InstalledEngine } from '@tunnelcode/engine';

/** One engine whose models are still being listed, and one already on PATH. */
export interface SplitEngines {
  /**
   * Every installed engine, with an empty model list. Ready as soon as `which`
   * resolves for all of them, which is what the QR screen is allowed to wait on.
   */
  immediate: AvailableEngine[];
  /**
   * Fills in with the complete list once every installed engine has answered what
   * it can run. Undefined when nothing is installed, so a caller can tell "nothing
   * to wait for" from "still waiting" without inspecting the array's length.
   */
  remaining: Promise<AvailableEngine[]> | undefined;
}

/**
 * Splits discovery into what is already known and what has to be asked for,
 * instead of waiting on both before returning either.
 *
 * `which` is milliseconds; an engine's own CLI can cost seconds, and the pairing
 * code should not sit behind that. The register message goes out with
 * `immediate`, which lists every installed engine with no models yet — honest
 * about what is known so far, rather than leaving an engine out because its list
 * was not ready. `remaining` resolves once every one of them has answered, and
 * is sent on as an `engines_updated` message that revises the list in place. See
 * ADR-020.
 */
export async function discoverEnginesSplit(): Promise<SplitEngines> {
  const installed = await findInstalledEngines();

  const immediate: AvailableEngine[] = installed.map((entry) => ({
    name: entry.name,
    label: entry.label,
    command: entry.command,
    models: [],
  }));

  if (installed.length === 0) {
    return { immediate, remaining: undefined };
  }

  const remaining = listAll(installed);

  return { immediate, remaining };
}

/** Asks every installed engine for its models, in parallel. */
async function listAll(installed: InstalledEngine[]): Promise<AvailableEngine[]> {
  return Promise.all(
    installed.map(async (entry): Promise<AvailableEngine> => ({
      name: entry.name,
      label: entry.label,
      command: entry.command,
      models: await entry.engine.listModels(),
    })),
  );
}
