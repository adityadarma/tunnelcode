import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import pkg from './package.json' with { type: 'json' };

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = '3000';

/**
 * Target of the dev proxy, taken from the same variables the server reads so a
 * changed port does not have to be edited in two places.
 *
 * 0.0.0.0 is a bind address, not something a browser can connect to, so it is
 * mapped back to loopback here.
 */
function serverTarget(): string {
  const host = process.env['HOST'] ?? DEFAULT_HOST;
  const port = process.env['PORT'] ?? DEFAULT_PORT;
  const reachable = host === '0.0.0.0' || host === '::' ? DEFAULT_HOST : host;

  return `http://${reachable}:${port}`;
}

/**
 * The web app is a separate build that lands in dist/web, which Fastify serves.
 * During development requests are proxied to the running server so the browser
 * talks to one origin, matching production.
 */
export default defineConfig(() => {
  const target = serverTarget();

  return {
    root: 'web',
    plugins: [tailwindcss(), react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        '/pair': target,
        '/sessions': target,
        '/conversations': target,
        '/health': target,
        '/ws': { target, ws: true },
      },
    },
  };
});
