import { homedir } from 'node:os';
import { join } from 'node:path';

const GLOBAL_FILE = 'tunnelcode.json';

/**
 * Resolves the global config path for the current platform. See ADR-011.
 * Windows uses APPDATA, everything else follows the XDG-style ~/.config path.
 *
 * This is the only config file. A project directory is never read from. See
 * ADR-019.
 */
export function globalConfigPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    const base =
      appData !== undefined && appData !== '' ? appData : join(homedir(), 'AppData', 'Roaming');
    return join(base, 'TunnelCode', GLOBAL_FILE);
  }

  return join(homedir(), '.config', 'tunnelcode', GLOBAL_FILE);
}
