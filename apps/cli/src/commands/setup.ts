import {
  globalConfigPath,
  loadGlobalConfig,
  loadGrants,
  writeGlobalConfig,
  writeGrants,
} from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES, findInstalledEngines } from '@tunnelcode/engine';
import type { EngineName } from '@tunnelcode/engine';
import { antigravitySummary, runAntigravityMenu } from './antigravity.js';
import { runDoctor } from './doctor.js';
import {
  DEFAULT_ANSWER_MINUTES,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_SILENCE_MINUTES,
  defaultConfig,
} from '../default-config.js';
import { CANCELLED, ask, select } from '../prompt.js';
import type { Choice } from '../prompt.js';
import { writeErr, writeOut } from '../output.js';
import { withSpinner } from '../spinner.js';
import { cyan, dim, green, yellow } from '../style.js';

type Field =
  | 'server'
  | 'device'
  | 'engine'
  | 'timeouts'
  | 'ceiling'
  | 'grants'
  | 'antigravity'
  | 'doctor'
  | 'back';

/** Separator for the deny list, which is read and written as one line. */
const RULE_SEPARATOR = ',';

/**
 * Configuration as the menu should offer it: what is stored, or the default that
 * would be stored. A field is never asked for without showing what it is now.
 *
 * Opening this menu is still not a decision, so nothing is written here. A first
 * run that goes straight to pairing has the file created for it instead, and this
 * shows the same values that run would have stored. See ADR-056.
 */
function draftFrom(stored: GlobalConfig | undefined): GlobalConfig {
  return stored ?? defaultConfig();
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

/**
 * Chooses the engine a new conversation starts on.
 *
 * Nothing is marked current on a machine that has never chosen, because the answer
 * then comes from what is installed rather than from this file. See ADR-056.
 *
 * Which engines are actually here is said beside each name. Every supported engine
 * is still offered: one can be chosen before it is installed, and a name is only
 * refused by the machine at the point a session needs it. What this removes is
 * having to scan a QR code to find out. See ADR-057.
 *
 * Only the executables are looked for, never the models, so this costs a `which`
 * per engine rather than the seconds listing models takes. See ADR-053.
 */
async function editEngine(draft: GlobalConfig): Promise<void> {
  const installed = await withSpinner('Checking engines...', () => findInstalledEngines());
  const isInstalled = (name: EngineName): boolean =>
    installed.some((engine) => engine.name === name);

  if (installed.length === 0) {
    writeOut('');
    writeOut(yellow('  None of these is installed on this machine.'));
    writeOut(dim('  One has to be installed before a session can run.'));
  }

  // The current one is marked, so the choice is never blind. Marked with what it
  // costs to pick it: whether it is here, and whether it is already the answer.
  const choices: Choice<EngineName>[] = ENGINE_NAMES.map((name) => {
    const hint = [
      name === draft.engine ? '(current)' : undefined,
      isInstalled(name) ? undefined : 'not installed',
    ]
      .filter((part) => part !== undefined)
      .join(' ');

    // Omitted rather than empty: a hint of '' still renders its separator, which
    // leaves trailing spaces on the installed engines nobody has chosen.
    return { value: name, label: name, ...(hint === '' ? {} : { hint }) };
  });

  const choice = await select('Engine', choices);

  if (choice === CANCELLED) {
    return;
  }

  await writeGlobalConfig({ ...draft, engine: choice });
  writeOut(green(`Engine set to ${cyan(choice)}`));

  // Stored either way: it is a preference, and a machine that gains the engine
  // later should find it already chosen. Saying so is what stops it looking like it
  // took effect. See ADR-057.
  if (!isInstalled(choice)) {
    writeOut(
      yellow(`${choice} is not installed, so new conversations start on the first engine that is.`),
    );
    writeOut(dim('  Install it and it will be used without changing this again.'));
  }
}

async function editTimeouts(draft: GlobalConfig): Promise<void> {
  const current = draft.timeouts;

  writeOut('');
  writeOut(
    dim(
      `  idleMinutes: session ends after this many minutes without activity (default: ${String(DEFAULT_IDLE_MINUTES)})`,
    ),
  );
  writeOut(
    dim(
      `  answerMinutes: permission ask times out after this many minutes (default: ${String(DEFAULT_ANSWER_MINUTES)})`,
    ),
  );
  writeOut(
    dim(
      `  silenceMinutes: turn abandoned after this many minutes without engine output (default: ${String(DEFAULT_SILENCE_MINUTES)})`,
    ),
  );
  writeOut('');

  type TimeoutChoice = 'idle' | 'answer' | 'silence' | 'defaults' | 'back';

  const choice = await select('Timeouts', [
    { value: 'idle', label: 'Idle timeout', hint: `${String(current.idleMinutes)} min` },
    { value: 'answer', label: 'Answer timeout', hint: `${String(current.answerMinutes)} min` },
    { value: 'silence', label: 'Silence timeout', hint: `${String(current.silenceMinutes)} min` },
    {
      value: 'defaults',
      label: 'Reset to defaults',
      hint: `${String(DEFAULT_IDLE_MINUTES)}/${String(DEFAULT_ANSWER_MINUTES)}/${String(DEFAULT_SILENCE_MINUTES)} min`,
    },
    { value: 'back', label: 'Back' },
  ] satisfies Choice<TimeoutChoice>[]);

  if (choice === CANCELLED || choice === 'back') {
    return;
  }

  if (choice === 'defaults') {
    await writeGlobalConfig({
      ...draft,
      timeouts: {
        idleMinutes: DEFAULT_IDLE_MINUTES,
        answerMinutes: DEFAULT_ANSWER_MINUTES,
        silenceMinutes: DEFAULT_SILENCE_MINUTES,
      },
    });
    writeOut(
      green(
        `Timeouts reset to defaults (idle: ${cyan(`${String(DEFAULT_IDLE_MINUTES)} min`)}, answer: ${cyan(`${String(DEFAULT_ANSWER_MINUTES)} min`)}, silence: ${cyan(`${String(DEFAULT_SILENCE_MINUTES)} min`)})`,
      ),
    );
    return;
  }

  const label =
    choice === 'idle' ? 'Idle minutes' : choice === 'answer' ? 'Answer minutes' : 'Silence minutes';
  const currentValue =
    choice === 'idle'
      ? current.idleMinutes
      : choice === 'answer'
        ? current.answerMinutes
        : current.silenceMinutes;

  const answer = await ask({ label, current: String(currentValue) });

  if (answer === CANCELLED) {
    return;
  }

  const value = Number(answer);

  if (!Number.isFinite(value) || value <= 0) {
    writeErr('Must be a positive number.');
    return;
  }

  if (choice === 'idle') {
    await writeGlobalConfig({ ...draft, timeouts: { ...current, idleMinutes: value } });
    writeOut(green(`Idle timeout set to ${cyan(`${String(value)} min`)}`));
  } else if (choice === 'answer') {
    await writeGlobalConfig({ ...draft, timeouts: { ...current, answerMinutes: value } });
    writeOut(green(`Answer timeout set to ${cyan(`${String(value)} min`)}`));
  } else {
    await writeGlobalConfig({ ...draft, timeouts: { ...current, silenceMinutes: value } });
    writeOut(green(`Silence timeout set to ${cyan(`${String(value)} min`)}`));
  }
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

    const choice = await select('Setup', [
      { value: 'server', label: 'Server URL', hint: draft.server.url },
      { value: 'device', label: 'Device name', hint: draft.device.name },
      {
        value: 'engine',
        label: 'Engine',
        // Said rather than shown as a name, because nothing has been chosen and the
        // installed engines decide it. Naming one here would read as a setting.
        hint: draft.engine ?? 'first installed',
      },
      {
        value: 'timeouts',
        label: 'Timeouts',
        hint: `idle ${String(draft.timeouts.idleMinutes)}m, answer ${String(draft.timeouts.answerMinutes)}m, silence ${String(draft.timeouts.silenceMinutes)}m`,
      },
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
        label: 'Antigravity access',
        hint: await antigravitySummary(cwd),
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
      case 'timeouts':
        await editTimeouts(draft);
        break;
      case 'ceiling':
        await editCeiling(draft);
        break;
      case 'grants':
        await manageGrants();
        break;
      case 'antigravity':
        await runAntigravityMenu(cwd);
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
