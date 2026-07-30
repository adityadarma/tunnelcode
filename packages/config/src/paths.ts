import { homedir } from 'node:os';
import { join } from 'node:path';

const GLOBAL_FILE = 'remotecode.json';
const WORKSPACE_DIR = '.remotecode';
const WORKSPACE_FILE = 'config.json';

/**
 * Resolves the global config path for the current platform. See ADR-011.
 * Windows uses APPDATA, everything else follows the XDG-style ~/.config path.
 */
export function globalConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const base =
      appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming');
    return join(base, 'RemoteCode', GLOBAL_FILE);
  }

  return join(homedir(), '.config', 'remotecode', GLOBAL_FILE);
}

/**
 * Resolves the workspace config path for a project directory. See ADR-012.
 */
export function workspaceConfigPath(cwd: string): string {
  return join(cwd, WORKSPACE_DIR, WORKSPACE_FILE);
}
