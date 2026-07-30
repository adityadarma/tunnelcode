export const APP_NAME = 'remotecode';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { loadEnvFile } from './env.js';
