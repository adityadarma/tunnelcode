import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Path prefixes owned by the HTTP API. A wrong URL under these must stay a JSON
 * 404 rather than falling back to the app shell, so a broken request is not
 * mistaken for a working page.
 */
const API_PREFIXES = ['/pair', '/sessions', '/conversations', '/health', '/ws'];

/**
 * Serves the built web app.
 *
 * Unknown GET paths fall back to index.html so client side routes survive a
 * refresh.
 */
export async function registerWeb(app: FastifyInstance): Promise<void> {
  const root = join(import.meta.dirname, 'web');

  if (!existsSync(root)) {
    app.log.warn('Web app is not built, skipping static hosting.');
    return;
  }

  await app.register(fastifyStatic, { root });

  app.setNotFoundHandler((request, reply) => {
    const isApi = API_PREFIXES.some((prefix) => request.url.startsWith(prefix));

    if (request.method !== 'GET' || isApi) {
      return reply.code(404).send({ error: 'Not found.' });
    }

    return reply.sendFile('index.html');
  });
}
