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
] as const;

/** Keeps a target short enough to read in a conversation line. */
const TARGET_MAX_LENGTH = 120;

function shorten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= TARGET_MAX_LENGTH ? flat : `${flat.slice(0, TARGET_MAX_LENGTH - 1)}…`;
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
      return shorten(value);
    }
  }

  return undefined;
}
