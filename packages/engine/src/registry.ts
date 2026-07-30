import { ClaudeEngine } from './adapters/claude.js';
import { OpenCodeEngine } from './adapters/opencode.js';
import type { Engine } from './types.js';

/**
 * Engine names that can appear in configuration.
 */
export const ENGINE_NAMES = ['opencode', 'claude'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value);
}

/**
 * Builds the engine named in configuration. Returns undefined for an unknown
 * name so the caller can report the valid options instead of throwing.
 */
export function createEngine(name: string): Engine | undefined {
  if (!isEngineName(name)) {
    return undefined;
  }

  switch (name) {
    case 'opencode':
      return new OpenCodeEngine();
    case 'claude':
      return new ClaudeEngine();
  }
}

/**
 * An engine this machine can actually run, with the models it reported.
 *
 * Both halves are discovered together because they are only useful together: an
 * engine with no executable cannot answer, and an engine whose models are
 * unknown cannot be offered a model choice.
 */
export interface AvailableEngine {
  name: EngineName;
  command: string;
  models: string[];
}

/**
 * Engines that are both supported here and installed on this machine.
 *
 * The intersection is what the browser is offered, so a choice made there can
 * always be served: a supported engine that is not installed would fail at the
 * first prompt, and an installed one this project has no adapter for cannot be
 * driven at all. See ADR-020.
 *
 * Probed once at startup rather than per prompt. Every engine is asked in
 * parallel, since listing models spawns a process and doing that in sequence
 * would add up to a visible delay before the QR appears.
 */
export async function discoverEngines(): Promise<AvailableEngine[]> {
  const found = await Promise.all(
    ENGINE_NAMES.map(async (name): Promise<AvailableEngine | undefined> => {
      const engine = createEngine(name);

      if (engine === undefined || !(await engine.isAvailable())) {
        return undefined;
      }

      return { name, command: engine.command, models: await engine.listModels() };
    }),
  );

  return found.filter((entry): entry is AvailableEngine => entry !== undefined);
}
