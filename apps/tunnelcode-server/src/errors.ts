import type { FastifyError, FastifyInstance } from 'fastify';
import { sanitizeUrl } from './logging.js';

/**
 * Central error handler.
 *
 * Internal failures are logged in full but reported to the client as a plain
 * message, so a stack trace or a file path never reaches the browser. Client
 * errors keep their own message, which is what the user needs to fix the call.
 *
 * The URL is sanitized here as well as in the request serializer, because this
 * logs a field of its own rather than the request: a rate limited pair attempt or
 * a rejected session route would otherwise write the very thing the serializer
 * takes out.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    const url = sanitizeUrl(request.url);

    if (status >= 500) {
      app.log.error({ err: error, url }, 'Request failed.');
      return reply.code(status).send({ error: 'Internal server error.' });
    }

    app.log.warn({ url, message: error.message }, 'Request rejected.');
    return reply.code(status).send({ error: error.message });
  });
}
