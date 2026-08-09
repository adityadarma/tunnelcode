import { ConfigError } from '@tunnelcode/config';
import { runSetupMenu } from './commands/setup.js';
import { runStart } from './commands/start.js';
import { runUpdate } from './commands/update.js';
import { CANCELLED, select } from './prompt.js';
import type { Choice } from './prompt.js';
import { writeErr, writeOut } from './output.js';
import { checkForUpdate } from './update-check.js';

type Action = 'continue' | 'setup' | 'update' | 'exit';

/**
 * Main menu.
 *
 * There are no command line options: everything is chosen in the app, so the
 * agent cannot be pointed somewhere else by a flag or a variable. See ADR-018.
 *
 * When a newer version is available, an Update choice is shown so the user can
 * upgrade without leaving the menu.
 */
function menu(updateAvailable: boolean): Promise<Action | typeof CANCELLED> {
  const choices: Choice<Action>[] = [
    { value: 'continue', label: 'Scan QR' },
    { value: 'setup', label: 'Setup' },
    ...(updateAvailable
      ? [{ value: 'update' as const, label: 'Update', hint: 'new version available' }]
      : []),
    { value: 'exit', label: 'Exit' },
  ];

  return select('Main Menu', choices);
}

/**
 * Runs the menu until the user leaves it. Returns the process exit code, so the
 * entrypoint stays the only place that touches process state.
 */
export async function run(): Promise<number> {
  const cwd = process.cwd();

  // Fire the update check once before the menu loop. The result is reused for
  // every iteration so the menu never waits on the network after the first draw.
  const updateNotice = await checkForUpdate();
  let updateAvailable = updateNotice !== undefined;

  if (updateNotice !== undefined) {
    writeOut(updateNotice);
    writeOut('');
  }

  for (;;) {
    const action = await menu(updateAvailable);

    if (action === CANCELLED || action === 'exit') {
      writeOut('');
      writeOut('Bye.');
      return 0;
    }

    try {
      if (action === 'setup') {
        await runSetupMenu();
        continue;
      }

      if (action === 'update') {
        await runUpdate();
        // After a successful update the menu item is no longer needed.
        updateAvailable = false;
        continue;
      }

      // A session holds the terminal until it ends, and once it has ended the
      // pairing code is spent, so there is nothing left to return to.
      return await runStart(cwd);
    } catch (error) {
      if (error instanceof ConfigError) {
        writeErr(`${error.path}: ${error.message}`);
        return 1;
      }

      throw error;
    }
  }
}
