import { hostname } from 'node:os';
import {
  globalConfigPath,
  loadGlobalConfig,
  loadGrants,
  writeGlobalConfig,
  writeGrants,
} from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import {
  AntigravitySettingsError,
  ENGINE_NAMES,
  allowWorkspaceWrites,
  antigravitySettingsPath,
  isWorkspaceWritable,
  revokeWorkspaceWrites,
  workspaceWriteRule,
} from '@tunnelcode/engine';
import type { EngineName } from '@tunnelcode/engine';
import { runDoctor } from './doctor.js';
import { CANCELLED, ask, select } from '../prompt.js';
import type { Choice } from '../prompt.js';
import { writeErr, writeOut } from '../output.js';
import { resolveDefaultServerUrl } from '../server-url.js';
import { cyan, dim, green } from '../style.js';

const DEFAULT_ENGINE: EngineName = 'opencode';

type Field =
  'server' | 'device' | 'engine' | 'ceiling' | 'grants' | 'antigravity' | 'doctor' | 'back';

/** Separator for the deny list, which is read and written as one line. */
const RULE_SEPARATOR = ',';

/**
 * Configuration as the menu should offer it: what is stored, or the default that
 * would be stored. A field is never asked for without showing what it is now.
 */
function draftFrom(stored: GlobalConfig | undefined): GlobalConfig {
  return (
    stored ?? {
      server: { url: resolveDefaultServerUrl() },
      device: { name: hostname() },
      engine: DEFAULT_ENGINE,
      permission: { deny: [] },
    }
  );
}

/**
 * Rejects anything that is not an http(s) URL.
 *
 * The value becomes the address the agent connects to, so a typo that parses as
 * some other scheme would fail later with a much less obvious message.
 */
function validateServerUrl(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return 'That is not a URL. Include the scheme, for example http://localhost:3000';
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The URL must start with http:// or https://';
  }

  return undefined;
}

async function editServerUrl(draft: GlobalConfig): Promise<void> {
  const answer = await ask({ label: 'Server URL', current: draft.server.url });

  if (answer === CANCELLED) {
    return;
  }

  const problem = validateServerUrl(answer);

  if (problem !== undefined) {
    writeErr(problem);
    return;
  }

  await writeGlobalConfig({ ...draft, server: { url: answer } });
  writeOut(green(`Server URL set to ${cyan(answer)}`));
}

async function editDeviceName(draft: GlobalConfig): Promise<void> {
  const answer = await ask({ label: 'Device name', current: draft.device.name });

  if (answer === CANCELLED) {
    return;
  }

  await writeGlobalConfig({ ...draft, device: { name: answer } });
  writeOut(green(`Device name set to ${cyan(answer)}`));
}

async function editEngine(draft: GlobalConfig): Promise<void> {
  // The current one is marked, so the choice is never blind.
  const choices: Choice<EngineName>[] = ENGINE_NAMES.map((name) => ({
    value: name,
    label: name,
    ...(name === draft.engine ? { hint: '(current)' } : {}),
  }));

  const choice = await select('Engine', choices);

  if (choice === CANCELLED) {
    return;
  }

  await writeGlobalConfig({ ...draft, engine: choice });
  writeOut(green(`Engine set to ${cyan(choice)}`));
}

/**
 * Edits the limit on what this machine will ever agree to do.
 *
 * Answered here rather than in the browser on purpose: a paired session lives in a
 * phone that gets lost and left unlocked, while this prompt is only reachable from
 * a terminal on the machine itself. See ADR-022.
 */
async function editCeiling(draft: GlobalConfig): Promise<void> {
  const current = draft.permission.deny.join(`${RULE_SEPARATOR} `);

  writeOut('');
  writeOut(dim('  Tool names, optionally narrowed: Bash, Bash(rm *), WebFetch'));
  writeOut(dim('  These can never be allowed, whatever the browser answers.'));

  // A dash clears the list, because an empty answer means "keep it" everywhere
  // else in this menu and there would otherwise be no way back to none.
  writeOut(dim('  Enter - to allow everything to be asked about.'));

  const answer = await ask({
    label: 'Never allow',
    ...(current === '' ? {} : { current }),
  });

  if (answer === CANCELLED) {
    return;
  }

  const deny =
    answer.trim() === '-'
      ? []
      : [
          ...new Set(
            answer
              .split(RULE_SEPARATOR)
              .map((entry) => entry.trim())
              .filter((entry) => entry !== ''),
          ),
        ];

  await writeGlobalConfig({ ...draft, permission: { deny } });

  writeOut(
    green(
      deny.length === 0
        ? 'Nothing is refused outright any more.'
        : `Never allowing ${cyan(deny.join(`${RULE_SEPARATOR} `))}`,
    ),
  );
}

/**
 * Lists the rules granted from a phone, and offers to clear them.
 *
 * A lasting grant with no way to see or withdraw it would be the worst part of
 * this feature rather than the convenient one. See ADR-022.
 */
async function manageGrants(): Promise<void> {
  const grants = await loadGrants();

  if (grants.length === 0) {
    writeOut('');
    writeOut(dim('  Nothing has been granted from the browser yet.'));
    return;
  }

  writeOut('');
  writeOut(dim('  Granted from the browser, in force until cleared:'));

  for (const grant of grants) {
    writeOut(`  ${cyan(grant.rule)}  ${dim(new Date(grant.grantedAt).toLocaleString())}`);
  }

  const choice = await select('Granted permissions', [
    { value: 'keep', label: 'Keep them' },
    { value: 'clear', label: 'Clear all', hint: `${String(grants.length)} rules` },
  ] satisfies Choice<'keep' | 'clear'>[]);

  if (choice === CANCELLED || choice === 'keep') {
    return;
  }

  await writeGrants([]);
  writeOut(green('Cleared. Every tool call will be asked about again.'));
}

/**
 * Grants or withdraws Antigravity's write access to this workspace.
 *
 * Antigravity raises no permission ask, because headless mode has no prompt, so a
 * file it wants to write is refused instead of being asked about. The only thing
 * that changes that is a rule in Antigravity's own settings. See ADR-031.
 *
 * Done from here rather than at startup, and never silently: the file belongs to
 * `agy` and is read every time it runs, so this also changes the user's own terminal
 * sessions. That is theirs to decide, which is why it is a menu item and not a side
 * effect of choosing an engine.
 */
async function editAntigravityAccess(cwd: string): Promise<void> {
  const rule = await workspaceWriteRule(cwd);
  const allowed = await isWorkspaceWritable(cwd);

  writeOut('');
  writeOut(dim('  Antigravity cannot ask about a file it wants to write, so without'));
  writeOut(dim('  this it can read this workspace but never change it.'));
  writeOut('');
  writeOut(`  rule  ${cyan(rule)}`);
  writeOut(`  file  ${dim(antigravitySettingsPath())}`);
  writeOut('');
  writeOut(dim("  That file is Antigravity's own, and it is read every time agy runs,"));
  writeOut(dim('  so this applies to your own terminal sessions too.'));
  writeOut(dim('  Running commands stays refused either way.'));

  const choice = await select('Antigravity write access', [
    allowed
      ? { value: 'revoke', label: 'Withdraw it', hint: 'back to read-only' }
      : { value: 'allow', label: 'Allow writing in this workspace' },
    { value: 'keep', label: 'Leave it as it is' },
  ] satisfies Choice<'allow' | 'revoke' | 'keep'>[]);

  if (choice === CANCELLED || choice === 'keep') {
    return;
  }

  try {
    if (choice === 'allow') {
      const added = await allowWorkspaceWrites(cwd);
      writeOut(
        green(
          added
            ? `Antigravity may now write in ${cyan(cwd)}`
            : 'That rule was already there. Nothing changed.',
        ),
      );
      return;
    }

    const removed = await revokeWorkspaceWrites(cwd);
    writeOut(
      green(
        removed
          ? 'Withdrawn. Antigravity can read this workspace but not change it.'
          : 'That rule was not there. Nothing changed.',
      ),
    );
  } catch (error) {
    // Refusing to write beats clobbering a file this project does not own.
    if (error instanceof AntigravitySettingsError) {
      writeErr(`${error.path}: ${error.message}`);
      return;
    }

    throw error;
  }
}

/**
 * Runs the settings menu until the user goes back.
 *
 * Every field is written as soon as it is answered, so leaving the menu at any
 * point never discards a change the user already confirmed.
 */
export async function runSetupMenu(): Promise<void> {
  for (;;) {
    const stored = await loadGlobalConfig();
    const draft = draftFrom(stored);

    const grants = await loadGrants();
    const cwd = process.cwd();
    const antigravityAllowed = await isWorkspaceWritable(cwd);

    const choice = await select('Setup', [
      { value: 'server', label: 'Server URL', hint: draft.server.url },
      { value: 'device', label: 'Device name', hint: draft.device.name },
      { value: 'engine', label: 'Engine', hint: draft.engine },
      {
        value: 'ceiling',
        label: 'Never allow',
        hint:
          draft.permission.deny.length === 0
            ? 'nothing'
            : draft.permission.deny.join(`${RULE_SEPARATOR} `),
      },
      {
        value: 'grants',
        label: 'Granted permissions',
        hint: grants.length === 0 ? 'none' : `${String(grants.length)} rules`,
      },
      {
        value: 'antigravity',
        label: 'Antigravity write access',
        hint: antigravityAllowed ? 'this workspace' : 'read-only',
      },
      { value: 'doctor', label: 'Check environment' },
      { value: 'back', label: 'Back' },
    ] satisfies Choice<Field>[]);

    if (choice === CANCELLED || choice === 'back') {
      return;
    }

    switch (choice) {
      case 'server':
        await editServerUrl(draft);
        break;
      case 'device':
        await editDeviceName(draft);
        break;
      case 'engine':
        await editEngine(draft);
        break;
      case 'ceiling':
        await editCeiling(draft);
        break;
      case 'grants':
        await manageGrants();
        break;
      case 'antigravity':
        await editAntigravityAccess(cwd);
        break;
      case 'doctor':
        await runDoctor();
        break;
    }

    // Written on the first change, so a first run leaves a complete config
    // behind rather than only the field that was touched.
    if (stored === undefined) {
      writeOut('');
      writeOut(dim(`Configuration stored at ${globalConfigPath()}`));
    }
  }
}
