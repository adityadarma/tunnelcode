import { AntigravityEngine } from './adapters/antigravity.js';
import { ClaudeEngine } from './adapters/claude.js';
import { CodexEngine } from './adapters/codex.js';
import { CopilotEngine } from './adapters/copilot.js';
import { CursorEngine } from './adapters/cursor.js';
import { KiroEngine } from './adapters/kiro.js';
import { OpenCodeEngine } from './adapters/opencode.js';
import type { Engine, EngineModel } from './types.js';

/**
 * Engine names that can appear in configuration.
 *
 * The order is the order Setup offers them in, so a name is appended rather than
 * inserted: the menu is answered by position when stdin is not a terminal.
 */
export const ENGINE_NAMES = [
  'opencode',
  'claude',
  'antigravity',
  'kiro',
  'codex',
  'copilot',
  'cursor',
] as const;

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
    case 'antigravity':
      return new AntigravityEngine();
    case 'kiro':
      return new KiroEngine();
    case 'codex':
      return new CodexEngine();
    case 'copilot':
      return new CopilotEngine();
    case 'cursor':
      return new CursorEngine();
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
  /** The engine's own name for itself, for showing rather than matching. */
  label: string;
  command: string;
  models: EngineModel[];
}

/**
 * An installed engine before anybody has asked it what it can answer with.
 *
 * Separate from AvailableEngine because the two halves of discovery cost wildly
 * different amounts. Finding the executable is a `which`, a few milliseconds; asking
 * for models runs the engine's own CLI, and some of them take seconds to start. A
 * caller that already knows the models can stop here and skip the slow half.
 * See ADR-053.
 */
export interface InstalledEngine {
  name: EngineName;
  label: string;
  command: string;
  /** The adapter itself, so the caller can ask it for models when it needs to. */
  engine: Engine;
}

/**
 * Engines that are both supported here and on this machine's PATH.
 *
 * Asked in parallel, and cheap either way: this is the half of discovery that only
 * looks for an executable.
 */
export async function findInstalledEngines(): Promise<InstalledEngine[]> {
  const found = await Promise.all(
    ENGINE_NAMES.map(async (name): Promise<InstalledEngine | undefined> => {
      const engine = createEngine(name);

      if (engine === undefined || !(await engine.isAvailable())) {
        return undefined;
      }

      return { name, label: engine.label, command: engine.command, engine };
    }),
  );

  return found.filter((entry): entry is InstalledEngine => entry !== undefined);
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
  const installed = await findInstalledEngines();

  return Promise.all(
    installed.map(async ({ name, label, command, engine }) => ({
      name,
      label,
      command,
      models: await engine.listModels(),
    })),
  );
}
