import type { FastifyError, FastifyInstance } from 'fastify';

/**
 * Central error handler.
 *
 * Internal failures are logged in full but reported to the client as a plain
 * message, so a stack trace or a file path never reaches the browser. Client
 * errors keep their own message, which is what the user needs to fix the call.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      app.log.error({ err: error, url: request.url }, 'Request failed.');
      return reply.code(status).send({ error: 'Internal server error.' });
    }

    app.log.warn({ url: request.url, message: error.message }, 'Request rejected.');
    return reply.code(status).send({ error: error.message });
  });
}
