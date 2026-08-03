/**
 * Line numbers in tool output, and the separator glued to them.
 *
 * Numbered output arrives from more than one place and in more than one shape. A
 * `read` prints `12: const x = 1`. A `grep -n` prints `12:const x = 1` for a match
 * and `13-const y = 2` for a line of context around it. Neither separator is part of
 * the file, and both read as part of it: a colon in front of code that is already
 * full of colons, and a dash in front of code where a dash means subtraction.
 *
 * The number itself is kept. It says which line of the file this is, which is the
 * reason for printing it at all.
 *
 * This is a display concern, so it lives here rather than in an adapter: the event
 * carries what the tool printed, whole, and the browser decides how to read it.
 */

/** Indent, number, separator, then the line. */
const NUMBERED_LINE = /^( *)(\d+)([:-])(.*)$/;

interface NumberedLine {
  indent: string;
  /** As printed, so a padded or zero-filled gutter is shown the way it arrived. */
  digits: string;
  /** The same number to count with. */
  number: number;
  text: string;
}

function parse(line: string): NumberedLine | undefined {
  const match = NUMBERED_LINE.exec(line);

  if (match === null) {
    return undefined;
  }

  const [, indent = '', digits = '', , text = ''] = match;

  return { indent, digits, number: Number(digits), text };
}

/**
 * Whether the tool put a space of its own after the separator.
 *
 * Decided across the whole run rather than line by line, because the space cannot be
 * told from the line's own indentation on any single line. A read pads every line, so
 * every line starts with one. A grep pads none, so a line that starts at column zero
 * gives the run away, and the leading whitespace on the rest is the file's.
 */
function isPadded(run: NumberedLine[]): boolean {
  return run.every(({ text }) => text === '' || text.startsWith(' '));
}

/** The number, one space, then the line, with no trailing space where it is empty. */
function render({ indent, digits, text }: NumberedLine, padded: boolean): string {
  const line = padded ? text.slice(1) : text;

  return line === '' ? `${indent}${digits}` : `${indent}${digits} ${line}`;
}

/**
 * Replaces the separator after a line number with a space.
 *
 * Only a run of at least two lines whose numbers count up one at a time is treated as
 * numbering. A single line, or lines whose numbers repeat or jump, is left exactly as
 * it came: `2026-08-03 started` opens with digits and a dash without being a numbered
 * line, and a run of them all carries the same year rather than counting. Requiring
 * the count is what tells the two apart without a list of tools to trust.
 */
export function withoutNumberSeparators(output: string): string {
  const lines = output.split('\n');
  const parsed = lines.map(parse);
  const shown = [...lines];

  let start = 0;

  while (start < lines.length) {
    if (parsed[start] === undefined) {
      start += 1;
      continue;
    }

    let end = start + 1;

    while (end < lines.length) {
      const previous = parsed[end - 1];
      const current = parsed[end];

      if (
        previous === undefined ||
        current === undefined ||
        current.number !== previous.number + 1
      ) {
        break;
      }

      end += 1;
    }

    // A number on its own line says nothing about being a line number, and one line
    // costs nothing to read as it came.
    if (end - start > 1) {
      const run = parsed.slice(start, end).filter((entry) => entry !== undefined);
      const padded = isPadded(run);

      for (const [offset, entry] of run.entries()) {
        shown[start + offset] = render(entry, padded);
      }
    }

    start = end;
  }

  return shown.join('\n');
}
