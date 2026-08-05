import { hostname } from 'node:os';
import {
  globalConfigPath,
  loadGlobalConfig,
  loadGrants,
  writeGlobalConfig,
  writeGrants,
} from '@tunnelcode/config';
import type { GlobalConfig } from '@tunnelcode/config';
import { ENGINE_NAMES } from '@tunnelcode/engine';
import type { EngineName } from '@tunnelcode/engine';
import { antigravitySummary, runAntigravityMenu } from './antigravity.js';
import { runDoctor } from './doctor.js';
import { CANCELLED, ask, select } from '../prompt.js';
import type { Choice } from '../prompt.js';
import { writeErr, writeOut } from '../output.js';
import { resolveDefaultServerUrl } from '../server-url.js';
import { cyan, dim, green } from '../style.js';

const DEFAULT_ENGINE: EngineName = 'opencode';

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
 */
function draftFrom(stored: GlobalConfig | undefined): GlobalConfig {
  return (
    stored ?? {
      server: { url: resolveDefaultServerUrl() },
      device: { name: hostname() },
      engine: DEFAULT_ENGINE,
      timeouts: { idleMinutes: 60, answerMinutes: 5 },
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

const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_ANSWER_MINUTES = 5;

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
  writeOut('');

  type TimeoutChoice = 'idle' | 'answer' | 'defaults' | 'back';

  const choice = await select('Timeouts', [
    { value: 'idle', label: 'Idle timeout', hint: `${String(current.idleMinutes)} min` },
    { value: 'answer', label: 'Answer timeout', hint: `${String(current.answerMinutes)} min` },
    {
      value: 'defaults',
      label: 'Reset to defaults',
      hint: `${String(DEFAULT_IDLE_MINUTES)}/${String(DEFAULT_ANSWER_MINUTES)} min`,
    },
    { value: 'back', label: 'Back' },
  ] satisfies Choice<TimeoutChoice>[]);

  if (choice === CANCELLED || choice === 'back') {
    return;
  }

  if (choice === 'defaults') {
    await writeGlobalConfig({
      ...draft,
      timeouts: { idleMinutes: DEFAULT_IDLE_MINUTES, answerMinutes: DEFAULT_ANSWER_MINUTES },
    });
    writeOut(
      green(
        `Timeouts reset to defaults (idle: ${cyan(`${String(DEFAULT_IDLE_MINUTES)} min`)}, answer: ${cyan(`${String(DEFAULT_ANSWER_MINUTES)} min`)})`,
      ),
    );
    return;
  }

  const isIdle = choice === 'idle';
  const label = isIdle ? 'Idle minutes' : 'Answer minutes';
  const currentValue = isIdle ? current.idleMinutes : current.answerMinutes;

  const answer = await ask({ label, current: String(currentValue) });

  if (answer === CANCELLED) {
    return;
  }

  const value = Number(answer);

  if (!Number.isFinite(value) || value <= 0) {
    writeErr('Must be a positive number.');
    return;
  }

  if (isIdle) {
    await writeGlobalConfig({ ...draft, timeouts: { ...current, idleMinutes: value } });
    writeOut(green(`Idle timeout set to ${cyan(`${String(value)} min`)}`));
  } else {
    await writeGlobalConfig({ ...draft, timeouts: { ...current, answerMinutes: value } });
    writeOut(green(`Answer timeout set to ${cyan(`${String(value)} min`)}`));
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
      { value: 'engine', label: 'Engine', hint: draft.engine },
      {
        value: 'timeouts',
        label: 'Timeouts',
        hint: `idle ${String(draft.timeouts.idleMinutes)}m, answer ${String(draft.timeouts.answerMinutes)}m`,
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
