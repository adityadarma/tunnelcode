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
  /**
   * Limit on what this machine will ever agree to do, whatever the browser
   * answers.
   *
   * Kept here rather than anywhere a phone can reach, because a paired session
   * lives in a device that gets lost, borrowed and left unlocked, while this file
   * is only answered from a terminal on the machine itself. See ADR-022.
   *
   * Defaulted rather than required, so a config written before this existed still
   * loads.
   */
  permission: z
    .object({
      /**
       * Rules that can never be allowed. Written as a tool name, optionally
       * narrowed to what it acts on: `Bash` or `Bash(rm *)`.
       */
      deny: z.array(z.string().min(1)),
    })
    .default({ deny: [] }),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
