import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const GLOBAL_FILE = 'tunnelcode.json';
const GRANTS_FILE = 'permissions.json';

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

/**
 * Where lasting permission grants are kept, next to the global config.
 *
 * A separate file on purpose. These accumulate from taps on a phone rather than
 * being typed by anyone, and mixing them into the settings file would turn a file
 * the user is meant to read into one they cannot reason about. See ADR-022.
 */
export function grantsPath(): string {
  return join(dirname(globalConfigPath()), GRANTS_FILE);
}
