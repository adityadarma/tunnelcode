/**
 * Argument keys that describe what a tool acted on, in the order they are
 * preferred.
 *
 * Engines name these differently and a single tool call often carries several of
 * them, so the first match wins: a path is more useful to show than the content
 * that was written to it.
 */
const TARGET_KEYS = [
  'file_path',
  'filePath',
  'path',
  'command',
  'pattern',
  'query',
  'url',
  'notebook_path',
  'description',
] as const;

/**
 * Puts a target on one line, which is all this does to it.
 *
 * Deliberately not cut to a length. A target is read as the thing that happened,
 * and a chained shell command ends in the part that matters, so a trailing ellipsis
 * hides exactly what a person is looking for. It is also what a permission rule is
 * judged against, and a rule granted for a cut command means something other than
 * the command that ran. How much of it fits on screen is the surface's business,
 * and the browser already scrolls a long one.
 */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Picks the most descriptive argument of a tool call.
 *
 * Returns undefined when nothing recognisable is there, so the activity is shown
 * as the tool name alone rather than as a tool acting on random JSON.
 */
export function readActivityTarget(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;

  for (const key of TARGET_KEYS) {
    const value = record[key];

    if (typeof value === 'string' && value.trim() !== '') {
      return oneLine(value);
    }
  }

  return undefined;
}
