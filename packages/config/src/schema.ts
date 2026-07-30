import { z } from 'zod';

/**
 * Configuration for this machine, the only configuration there is.
 *
 * One engine rather than a default plus a per-project override: the project
 * config was removed, so there is nothing left for a default to be defaulted
 * against. See ADR-019.
 */
export const globalConfigSchema = z.object({
  server: z.object({
    url: z.url(),
  }),
  device: z.object({
    name: z.string().min(1),
  }),
  engine: z.string().min(1),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
