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
   * Timeout configuration, in minutes. Each field falls back to its hardcoded
   * default when absent, so existing config files keep working untouched.
   */
  timeouts: z
    .object({
      /** Minutes without conversation before the session ends. Default: 60. */
      idleMinutes: z.number().positive().default(60),
      /** Minutes a tool-run approval waits before being auto-refused. Default: 5. */
      answerMinutes: z.number().positive().default(5),
      /**
       * Minutes without engine output before the turn is abandoned. Default: 15.
       *
       * Antigravity can run long commands (tests, builds) that produce no streaming
       * output until they finish. Set higher if builds routinely take longer.
       */
      silenceMinutes: z.number().positive().default(15),
    })
    .default({ idleMinutes: 60, answerMinutes: 5, silenceMinutes: 15 }),
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
