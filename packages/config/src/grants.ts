import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { grantsPath } from './paths.js';
import { writeJsonFile } from './write.js';

/**
 * A permission this machine has been told to stop asking about.
 *
 * Scoped to the device rather than to a conversation: what was granted is what
 * this machine may do, and that does not change when the user starts a new
 * conversation about the same work. See ADR-022.
 */
export interface PermissionGrant {
  /** A tool name, optionally narrowed: `Bash` or `Bash(curl *)`. */
  rule: string;
  grantedAt: number;
}

const grantsFileSchema = z.object({
  grants: z.array(
    z.object({
      rule: z.string().min(1),
      grantedAt: z.number(),
    }),
  ),
});

/**
 * Reads the grants this machine has accumulated.
 *
 * An unreadable or malformed file is treated as no grants at all. Unlike the
 * settings file this is not something anyone typed, so refusing to start over it
 * would block the CLI on a file the user never touched. Losing grants only means
 * being asked again, which is the safe direction to fail in.
 */
export async function loadGrants(): Promise<PermissionGrant[]> {
  let raw: string;

  try {
    raw = await readFile(grantsPath(), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const result = grantsFileSchema.safeParse(parsed);
  return result.success ? result.data.grants : [];
}

/** Replaces the stored grants, which is also how they are cleared. */
export async function writeGrants(grants: readonly PermissionGrant[]): Promise<string> {
  const path = grantsPath();
  await writeJsonFile(path, grantsFileSchema.parse({ grants: [...grants] }));
  return path;
}

/**
 * Adds rules to the stored grants, ignoring any that are already there.
 *
 * Returns the rules that were actually new, so the caller can say what changed
 * rather than claiming a grant it did not make.
 */
export async function addGrants(rules: readonly string[]): Promise<string[]> {
  const existing = await loadGrants();
  const known = new Set(existing.map((grant) => grant.rule));
  const added = [...new Set(rules)].filter((rule) => rule !== '' && !known.has(rule));

  if (added.length === 0) {
    return [];
  }

  const grantedAt = Date.now();
  await writeGrants([...existing, ...added.map((rule) => ({ rule, grantedAt }))]);

  return added;
}
