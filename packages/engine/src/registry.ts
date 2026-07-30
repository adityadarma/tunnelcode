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
