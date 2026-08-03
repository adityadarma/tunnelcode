import { writeOut, writeRaw } from './output.js';
import { cyan, dim } from './style.js';

/**
 * A one-line animated status for work the user has to wait on.
 *
 * The menu erases itself once it is answered, so a step that takes a second or
 * two leaves an empty terminal and no sign that anything is happening. This says
 * the wait is expected without claiming any progress it cannot measure.
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_MS = 80;

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
/** Back to the start of the line, then clear it, so each frame replaces the last. */
const CLEAR_LINE = '\r\u001b[2K';

/**
 * A terminal that can redraw one line in place. A pipe cannot, and neither can a
 * dumb terminal, so both get the label as plain text instead.
 */
const isAnimatable = process.stdout.isTTY && process.env['TERM'] !== 'dumb';

/**
 * Runs the given work while a spinner labelled with `label` sits on screen, and
 * takes the line back off once it is done.
 *
 * The result and any thrown error pass straight through, so wrapping a call
 * changes what the user sees and nothing else.
 */
export async function withSpinner<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!isAnimatable) {
    // Still worth saying once: a script reading this output waits just as long.
    writeOut(label);
    return run();
  }

  let frame = 0;

  const draw = (): void => {
    const glyph = FRAMES[frame % FRAMES.length] ?? '';
    frame += 1;
    writeRaw(`${CLEAR_LINE}  ${cyan(glyph)} ${dim(label)}`);
  };

  // A hidden cursor outlives the process, so an exit while spinning would leave
  // the user's shell without one.
  const restoreCursor = (): void => {
    writeRaw(SHOW_CURSOR);
  };

  process.once('exit', restoreCursor);
  writeRaw(HIDE_CURSOR);
  draw();

  const timer = setInterval(draw, FRAME_MS);
  // An animation is not work worth staying alive for: a referenced timer would
  // hold the event loop open after the awaited work has finished.
  timer.unref();

  try {
    return await run();
  } finally {
    clearInterval(timer);
    process.off('exit', restoreCursor);
    // Erased rather than left as a finished line: what the caller prints next is
    // the part worth reading.
    writeRaw(`${CLEAR_LINE}${SHOW_CURSOR}`);
  }
}
