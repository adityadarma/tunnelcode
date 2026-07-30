import type { GlobalConfig, ResolvedConfig, WorkspaceConfig } from './schema.js';

/**
 * Applies the workspace config on top of the global config. Only the engine can
 * be overridden per workspace, so each project can use a different engine while
 * the server and device stay machine wide. See ADR-012.
 */
export function mergeConfig(
  global: GlobalConfig,
  workspace: WorkspaceConfig | undefined,
): ResolvedConfig {
  return {
    serverUrl: global.server.url,
    deviceName: global.device.name,
    engine: workspace?.engine ?? global.defaultEngine,
  };
}
