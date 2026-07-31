export { ConfigError } from './error.js';
export { machineIdPath, readOrCreateDeviceId } from './device-id.js';
export { globalConfigPath, grantsPath } from './paths.js';
export { loadGlobalConfig } from './load.js';
export { writeGlobalConfig } from './write.js';
export { addGrants, loadGrants, writeGrants } from './grants.js';
export type { PermissionGrant } from './grants.js';
export { globalConfigSchema } from './schema.js';
export type { GlobalConfig } from './schema.js';
