import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The UI tests need a DOM, which node:test does not provide, so the web app is
 * tested with vitest while everything else stays on the built-in runner.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['web/**/*.test.tsx', 'web/**/*.test.ts'],
    globals: true,
    restoreMocks: true,
  },
});
