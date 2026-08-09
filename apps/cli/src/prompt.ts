import { writeOut, writeRaw } from './output.js';
import { bold, cyan, cyanBold, dim } from './style.js';

/**
 * Terminal prompts used by the in-app menu.
 *
 * Written by hand rather than pulled from a package: the menu needs one list and
 * one text field, which is less code than a dependency would cost to justify.
 */

const ESC = '\u001b';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

/** Cancelled by the user, which every caller has to handle. */
export const CANCELLED = Symbol('cancelled');

export interface Choice<T> {
  value: T;
  label: string;
  /** Shown dimmed after the label, for the current value or a short note. */
  hint?: string;
}

type Key = 'up' | 'down' | 'enter' | 'cancel' | 'other';

function keyFrom(chunk: string): Key {
  switch (chunk) {
    case `${ESC}[A`:
    case 'k':
      return 'up';
    case `${ESC}[B`:
    case 'j':
      return 'down';
    case '\r':
    case '\n':
      return 'enter';
    // Escape, Ctrl+C and Ctrl+D all mean "leave this prompt alone".
    case ESC:
    case CTRL_C:
    case CTRL_D:
    case 'q':
      return 'cancel';
    default:
      return 'other';
  }
}

/**
 * Reads one keypress in raw mode.
 *
 * Raw mode is switched on and off around each prompt rather than held open, so a
 * prompt that ends leaves the terminal exactly as it was found.
 */
async function withRawStdin<T>(run: (stdin: NodeJS.ReadStream) => Promise<T>): Promise<T> {
  const stdin = process.stdin;

  // An earlier prompt unrefs stdin so the process can exit, which would
  // otherwise make this read never deliver anything.
  stdin.ref();
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  try {
    return await run(stdin);
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    // A referenced stdin keeps the event loop alive, so the CLI would finish its
    // work and then hang instead of exiting.
    stdin.unref();
  }
}

function readKey(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: string): void => {
      stdin.off('data', onData);
      resolve(chunk);
    };

    stdin.on('data', onData);
  });
}

/**
 * Input read from a pipe but not consumed yet.
 *
 * Piped input arrives in whatever chunks the writer produced, so several answers
 * can land in one chunk and one answer can be split across two. Without a buffer
 * that spans reads, a script answering more than one prompt would lose everything
 * after the first newline.
 */
let pending = '';
/** Set once the pipe is closed, so later prompts stop waiting for a line. */
let inputEnded = false;

function takeBufferedLine(): string | undefined {
  const newline = pending.indexOf('\n');

  if (newline === -1) {
    return undefined;
  }

  const line = pending.slice(0, newline);
  pending = pending.slice(newline + 1);

  // A pipe written on Windows ends its lines with CRLF. Left in place the CR
  // becomes part of the answer, so a server URL would carry an invisible
  // trailing character and fail validation.
  return line.replace(/\r$/, '');
}

/**
 * Reads one line, used when stdin is not a TTY.
 *
 * stdin is paused and unref'd once the line arrives. A referenced stdin holds
 * the event loop open, so a CLI waiting on the network would ignore SIGINT and
 * never exit.
 */
async function readLine(): Promise<string | typeof CANCELLED> {
  const buffered = takeBufferedLine();

  if (buffered !== undefined) {
    return buffered;
  }

  if (inputEnded) {
    return CANCELLED;
  }

  const stdin = process.stdin;
  stdin.ref();
  stdin.resume();
  stdin.setEncoding('utf8');

  try {
    return await new Promise<string | typeof CANCELLED>((resolve) => {
      const finish = (value: string | typeof CANCELLED): void => {
        stdin.off('data', onData);
        stdin.off('end', onEnd);
        resolve(value);
      };

      const onData = (chunk: string): void => {
        pending += chunk;
        const line = takeBufferedLine();

        if (line !== undefined) {
          finish(line);
        }
      };

      // Closed input means nobody is there to answer. Anything left without a
      // trailing newline is still a complete answer.
      const onEnd = (): void => {
        inputEnded = true;

        if (pending === '') {
          finish(CANCELLED);
          return;
        }

        const rest = pending;
        pending = '';
        finish(rest);
      };

      stdin.on('data', onData);
      stdin.on('end', onEnd);
    });
  } finally {
    stdin.pause();
    stdin.unref();
  }
}

/**
 * Takes the given number of lines back off the screen, cursor ending where the
 * block started.
 *
 * Used when a prompt is done with: an answered menu left on screen pushes the
 * next one further down, so the terminal fills up with choices that have already
 * been made.
 */
function eraseLines(count: number): void {
  if (count <= 0) {
    return;
  }

  // Up to the first line of the block, then clear everything from there down.
  writeRaw(`\u001b[${String(count)}A\u001b[0J`);
}

function renderChoices<T>(choices: readonly Choice<T>[], active: number): void {
  choices.forEach((choice, index) => {
    const isActive = index === active;
    const marker = isActive ? cyanBold('❯') : ' ';
    const label = isActive ? bold(cyan(choice.label)) : dim(choice.label);
    const hint = choice.hint === undefined ? '' : dim(`  ${choice.hint}`);
    writeRaw(`\u001b[2K  ${marker} ${label}${hint}\n`);
  });
}

/**
 * Asks the user to pick one entry from a list.
 *
 * Returns CANCELLED when the user backs out, which the menu treats as "go up one
 * level" rather than as an error.
 */
export async function select<T>(
  title: string,
  choices: readonly Choice<T>[],
): Promise<T | typeof CANCELLED> {
  const first = choices[0];

  if (first === undefined) {
    return CANCELLED;
  }

  writeOut('');
  writeOut(cyanBold(`❖ ${title}`));
  writeOut('');

  if (!process.stdin.isTTY) {
    return selectByLine(choices);
  }

  // A blank line, the title, another blank line, then one line per choice.
  const drawnLines = 3 + choices.length;

  return withRawStdin(async (stdin) => {
    let active = 0;
    // Hidden so the cursor does not sit in the middle of a redrawn list.
    writeRaw('\u001b[?25l');
    renderChoices(choices, active);

    try {
      for (;;) {
        const key = keyFrom(await readKey(stdin));

        if (key === 'cancel') {
          return CANCELLED;
        }

        if (key === 'enter') {
          const choice = choices[active];
          return choice === undefined ? CANCELLED : choice.value;
        }

        if (key === 'up' || key === 'down') {
          const step = key === 'up' ? -1 : 1;
          // Wraps, so a long list is reachable from either end.
          active = (active + step + choices.length) % choices.length;
          writeRaw(`\u001b[${String(choices.length)}A`);
          renderChoices(choices, active);
        }
      }
    } finally {
      writeRaw('\u001b[?25h');
      // The list has served its purpose once it is answered. Clearing it here
      // rather than clearing the screen before the next prompt keeps whatever the
      // chosen action printed, which is the part worth reading.
      eraseLines(drawnLines);
    }
  });
}

/**
 * List prompt for a stdin that cannot report keypresses, which is what a script
 * or a test provides. The list is numbered and read as one line.
 */
async function selectByLine<T>(choices: readonly Choice<T>[]): Promise<T | typeof CANCELLED> {
  choices.forEach((choice, index) => {
    const hint = choice.hint === undefined ? '' : `  ${choice.hint}`;
    writeOut(`${String(index + 1)}) ${choice.label}${hint}`);
  });

  writeOut('');
  writeRaw('Choose a number: ');

  const answer = await readLine();

  if (answer === CANCELLED) {
    return CANCELLED;
  }

  const index = Number.parseInt(answer.trim(), 10) - 1;
  const choice = choices[index];

  return choice === undefined ? CANCELLED : choice.value;
}

export interface AskOptions {
  label: string;
  /** Kept when the user answers with an empty line. */
  current?: string;
}

/**
 * Asks for one line of text. An empty answer keeps the current value, so a
 * settings field can be visited without being changed.
 */
export async function ask(options: AskOptions): Promise<string | typeof CANCELLED> {
  const current = options.current;

  writeOut('');

  if (current !== undefined) {
    writeOut(`  ${dim('Current')}  ${cyan(current)}`);
    writeOut(dim('  Press Enter to keep it.'));
  }

  writeRaw(`  ${bold(options.label)}: `);

  const answer = await readLine();

  // A blank line, the current value and its note when there is one, and the line
  // the terminal echoed as the answer was typed.
  const drawnLines = 2 + (current === undefined ? 0 : 2);

  // Only a terminal echoes the answer and understands the escape codes. A piped
  // stdin prints nothing back, so the count would be wrong and the erase would
  // eat a line that was never part of this prompt.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    // Ctrl+D ends the line without echoing a newline, so the cursor is still on
    // the label. Erasing from there would take a line that belongs to whatever
    // came before this prompt.
    if (answer === CANCELLED) {
      writeRaw('\n');
    }

    // Taken off the screen for the same reason the menu is: the answer shows up
    // in the confirmation, and in the field's hint the next time the menu draws.
    eraseLines(drawnLines);
  }

  if (answer === CANCELLED) {
    return CANCELLED;
  }

  const trimmed = answer.trim();

  if (trimmed === '') {
    return current ?? CANCELLED;
  }

  return trimmed;
}
