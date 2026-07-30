import { z } from 'zod';

export const globalConfigSchema = z.object({
  server: z.object({
    url: z.url(),
  }),
  device: z.object({
    name: z.string().min(1),
  }),
  defaultEngine: z.string().min(1),
});

export const workspaceConfigSchema = z.object({
  engine: z.string().min(1),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/**
 * Effective configuration after the workspace config has been applied on top of
 * the global config.
 */
export interface ResolvedConfig {
  serverUrl: string;
  deviceName: string;
  engine: string;
}
