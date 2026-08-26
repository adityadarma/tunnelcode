import { ConfigError } from '@tunnelcode/config';
import { runSetupMenu } from './commands/setup.js';
import { runStart } from './commands/start.js';
import { CANCELLED, select } from './prompt.js';
import type { Choice } from './prompt.js';
import { writeErr, writeOut } from './output.js';
import { checkForUpdate, pendingUpdateNotice } from './update-check.js';

type Action = 'continue' | 'setup' | 'exit';

/**
 * Main menu.
 *
 * There are no command line options: everything is chosen in the app, so the
 * agent cannot be pointed somewhere else by a flag or a variable. See ADR-018.
 */
function menu(): Promise<Action | typeof CANCELLED> {
  const choices: Choice<Action>[] = [
    { value: 'continue', label: 'Scan QR' },
    { value: 'setup', label: 'Setup' },
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

  // A version installed by an earlier run's background check is only worth
  // mentioning once this process can say so, which is the start of the next one.
  const updateNotice = await pendingUpdateNotice();

  if (updateNotice !== undefined) {
    writeOut(updateNotice);
    writeOut('');
  }

  // Fired and left running rather than awaited: a newer version installs itself
  // while the user is already at the menu, and the process that discovers it
  // cannot use it anyway, so nothing here is worth making the menu wait for.
  void checkForUpdate();

  for (;;) {
    const action = await menu();

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
