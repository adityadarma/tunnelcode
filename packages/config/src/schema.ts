import { isRecord } from '@tunnelcode/shared';
import { z } from 'zod';

/**
 * Accepts a config written by an earlier build, which called this field
 * `defaultEngine` because an engine could also be set per project.
 *
 * Without this an upgrade fails validation and the CLI exits before it can offer
 * the menu that would fix it. The value is rewritten under the current name the
 * next time anything is saved.
 */
function withLegacyEngine(value: unknown): unknown {
  if (!isRecord(value) || 'engine' in value || !('defaultEngine' in value)) {
    return value;
  }

  const { defaultEngine, ...rest } = value;

  return { ...rest, engine: defaultEngine };
}

/**
 * Configuration for this machine, the only configuration there is.
 *
 * One engine rather than a default plus a per-project override: the project
 * config was removed, so there is nothing left for a default to be defaulted
 * against. See ADR-019.
 */
export const globalConfigSchema = z.preprocess(
  withLegacyEngine,
  z.object({
    server: z.object({
      url: z.url(),
    }),
    device: z.object({
      name: z.string().min(1),
    }),
    engine: z.string().min(1),
  }),
);

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
