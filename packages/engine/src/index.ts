export { ClaudeEngine } from './adapters/claude.js';
export { OpenCodeEngine } from './adapters/opencode.js';
export { createEngine, discoverEngines, isEngineName, ENGINE_NAMES } from './registry.js';
export type { AvailableEngine, EngineName } from './registry.js';
export { isOnPath } from './which.js';
export type {
  Engine,
  EngineActivity,
  EngineBlocked,
  EngineDelta,
  EngineDone,
  EngineEvent,
  EngineFailure,
  EngineLog,
  EnginePermissionDecision,
  EnginePermissionRequest,
  EngineSession,
  PromptOptions,
} from './types.js';
