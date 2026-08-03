import {
  AntigravitySettingsError,
  RUN_COMMANDS_RULE,
  allowCommands,
  allowWorkspaceWrites,
  antigravitySettingsPath,
  areCommandsAllowed,
  isWorkspaceWritable,
  revokeCommands,
  revokeWorkspaceWrites,
  workspaceWriteRule,
} from '@tunnelcode/engine';
import { CANCELLED, select } from '../prompt.js';
import type { Choice } from '../prompt.js';
import { writeErr, writeOut } from '../output.js';
import { cyan, dim, green } from '../style.js';

/**
 * What Antigravity is allowed to do on this machine.
 *
 * Antigravity raises no permission ask, because headless mode has no prompt: a tool
 * call its policy will not approve is refused, and the turn carries on without it.
 * So nothing can be decided from a phone mid-turn the way it is for the other
 * engines. It is decided here instead, before a turn starts, and never
 * automatically. See ADR-031.
 */

type Item = 'writes' | 'commands' | 'back';

/** Both grants as they stand, read together so the menu shows one picture. */
async function state(cwd: string): Promise<{ writes: boolean; commands: boolean }> {
  const [writes, commands] = await Promise.all([isWorkspaceWritable(cwd), areCommandsAllowed()]);

  return { writes, commands };
}

/** The Setup hint: what the engine may do, in the order it is granted. */
export async function antigravitySummary(cwd: string): Promise<string> {
  const { writes, commands } = await state(cwd);
  const granted = [...(writes ? ['writes here'] : []), ...(commands ? ['runs commands'] : [])];

  return granted.length === 0 ? 'read-only' : granted.join(', ');
}

/** Says what a grant did, including the case where it changed nothing. */
function report(changed: boolean, done: string): void {
  writeOut(green(changed ? done : 'That rule was already as you asked. Nothing changed.'));
}

async function editWrites(cwd: string, allowed: boolean): Promise<void> {
  if (allowed) {
    report(
      await revokeWorkspaceWrites(cwd),
      'Withdrawn. Antigravity can read this workspace but not change it.',
    );
    return;
  }

  report(await allowWorkspaceWrites(cwd), `Antigravity may now write in ${cyan(cwd)}`);
}

async function editCommands(allowed: boolean): Promise<void> {
  if (allowed) {
    report(
      await revokeCommands(),
      'Withdrawn. A command Antigravity wants to run is refused again.',
    );
    return;
  }

  report(await allowCommands(), 'Antigravity may now run commands.');
}

/**
 * Grants or withdraws what Antigravity may do, one thing per visit.
 *
 * Done from here rather than at startup, and never silently: these are rules in
 * `agy`'s own settings file, which it reads every time it runs, so they also change
 * the user's own terminal sessions. That is theirs to decide, which is why it is a
 * menu item and not a side effect of choosing an engine.
 */
export async function runAntigravityMenu(cwd: string): Promise<void> {
  const { writes, commands } = await state(cwd);
  const writeRule = await workspaceWriteRule(cwd);

  writeOut('');
  writeOut(dim('  Antigravity cannot ask about a tool call, so anything needing approval'));
  writeOut(dim('  is refused instead. What it may do is decided here, before a turn starts.'));
  writeOut('');
  writeOut(`  writing   ${cyan(writeRule)}`);
  writeOut(`  commands  ${cyan(RUN_COMMANDS_RULE)}`);
  writeOut(`  file      ${dim(antigravitySettingsPath())}`);
  writeOut('');
  writeOut(dim("  These are rules in Antigravity's own settings, read every time agy runs,"));
  writeOut(dim('  so they apply to your own terminal sessions too.'));
  writeOut('');

  // Said plainly because the rule is wider than the two safeguards a user has
  // reason to expect: Antigravity writes its own command lines and prefixes them,
  // so a rule naming one program would refuse most of the work, and the engine
  // never asks, so the ceiling in this menu has nothing to refuse.
  writeOut(dim('  Running commands covers every command: a narrower rule would not match'));
  writeOut(dim('  the agent\u2019s own cd <dir> && \u2026 in front of it. Never allow cannot'));
  writeOut(dim('  hold it back either, because Antigravity never asks about a call.'));

  const choice = await select('Antigravity access', [
    writes
      ? { value: 'writes', label: 'Withdraw write access', hint: 'back to read-only' }
      : { value: 'writes', label: 'Allow writing in this workspace' },
    commands
      ? { value: 'commands', label: 'Withdraw command access', hint: 'back to refused' }
      : { value: 'commands', label: 'Allow running commands' },
    { value: 'back', label: 'Back' },
  ] satisfies Choice<Item>[]);

  if (choice === CANCELLED || choice === 'back') {
    return;
  }

  try {
    if (choice === 'writes') {
      await editWrites(cwd, writes);
      return;
    }

    await editCommands(commands);
  } catch (error) {
    // Refusing to write beats clobbering a file this project does not own.
    if (error instanceof AntigravitySettingsError) {
      writeErr(`${error.path}: ${error.message}`);
      return;
    }

    throw error;
  }
}
