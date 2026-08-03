/**
 * What opencode's read tool wraps a file in, and what is worth reading of it.
 *
 * The tool answers with an envelope of its own, recorded from opencode 1.18.10:
 *
 *     <path>/Users/me/project/src/thing.ts</path>
 *     <type>file</type>
 *     <content>
 *     1: first line
 *     2: second line
 *     (End of file - total 2 lines)
 *     </content>
 *
 * A directory is the same shape with `directory` as the type and `<entries>` in
 * place of `<content>`. A read that loaded other files can append a
 * `<system-reminder>` block after the closing tag.
 *
 * Kept out of the adapter file, which is long enough already, but it belongs to the
 * adapter: this is one engine's output shape, and normalising it is what an adapter
 * is for.
 */

/** The tags the body can be wrapped in, by the type that precedes them. */
const BODY_TAGS = new Map([
  ['file', 'content'],
  ['directory', 'entries'],
]);

const PATH_LINE = /^<path>.*<\/path>$/;
const TYPE_LINE = /^<type>(file|directory)<\/type>$/;

/**
 * Unwraps a read result, or returns it untouched.
 *
 * The path is dropped because it is already the activity's target, printed above
 * this output rather than in it, and it is the absolute one: three lines of
 * scrolling before the file starts, saying what the reader was just told. The line
 * numbers and the note that closes the body are kept, since those say which part of
 * the file this is and whether there is more of it.
 *
 * Anything that does not match the recorded shape exactly is returned as it came.
 * An output shape that changed is better read raw than quietly cut in half by a
 * guess at where it ends.
 */
export function readResultBody(output: string): string {
  const lines = output.split('\n');
  const [pathLine, typeLine, openLine] = lines;

  if (pathLine === undefined || typeLine === undefined || openLine === undefined) {
    return output;
  }

  const type = TYPE_LINE.exec(typeLine)?.[1];
  const tag = type === undefined ? undefined : BODY_TAGS.get(type);

  if (!PATH_LINE.test(pathLine) || tag === undefined || openLine !== `<${tag}>`) {
    return output;
  }

  // Searched from the end, because a file being read can contain the closing tag as
  // one of its own lines: this project's own source does.
  const close = lines.lastIndexOf(`</${tag}>`);

  if (close < 3) {
    return output;
  }

  // Nothing after the closing tag is kept. A system reminder is addressed to the
  // model, not to the person reading what the tool found.
  return lines.slice(3, close).join('\n');
}
