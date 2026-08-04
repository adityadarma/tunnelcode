import type { FastifyInstance } from 'fastify';
import { pairRequestSchema } from '@tunnelcode/protocol';
import { sessionCookie } from '../cookies.js';
import type { DeviceService } from '../services/device.js';
import type { SessionService } from '../services/session.js';
import type { CliRegistry } from '../ws/registry.js';

/** How many pair attempts a single client may make per window. */
const PAIR_MAX_ATTEMPTS = 10;
const PAIR_WINDOW = '1 minute';

/** How many status check attempts a single client may make per window. */
const PAIR_STATUS_MAX_ATTEMPTS = 60;
const PAIR_STATUS_WINDOW = '1 minute';

interface PairRoutesOptions {
  devices: DeviceService;
  sessions: SessionService;
  registry: CliRegistry;
}

/**
 * Pairing routes.
 *
 * A correct code is not enough to pair: the request only becomes a pending
 * approval, and the CLI has to approve it. The response therefore reveals
 * nothing beyond "this code exists", and even that is rate limited.
 * See ADR-014.
 */
export function registerPairRoutes(app: FastifyInstance, options: PairRoutesOptions): void {
  const { devices, sessions, registry } = options;

  app.post(
    '/pair',
    {
      config: {
        rateLimit: {
          max: PAIR_MAX_ATTEMPTS,
          timeWindow: PAIR_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const parsed = pairRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid pairing code.' });
      }

      const device = devices.findByCode(parsed.data.code);

      // A wrong code and an already paired device get the same answer, so the
      // response cannot be used to tell valid codes from invalid ones.
      if (device === undefined || device.paired) {
        return reply.code(404).send({ error: 'Pairing code is not available.' });
      }

      if (!registry.isConnected(device.id)) {
        return reply.code(404).send({ error: 'Pairing code is not available.' });
      }

      const pending = sessions.createPending(device.id);
      registry.send(device.id, {
        type: 'pair_request',
        requestId: pending.id,
        approvalNumber: pending.approvalNumber,
      });

      return reply.code(202).send({
        status: 'pending',
        requestId: pending.id,
        approvalNumber: pending.approvalNumber,
      });
    },
  );

  app.get(
    '/pair/:requestId/status',
    {
      config: {
        rateLimit: {
          max: PAIR_STATUS_MAX_ATTEMPTS,
          timeWindow: PAIR_STATUS_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const params = request.params as { requestId?: string };
      const requestId = params.requestId;

      if (requestId === undefined || requestId === '') {
        return reply.code(400).send({ error: 'Missing request id.' });
      }

      const outcome = sessions.outcomeOf(requestId);

      if (outcome.status === 'unknown') {
        return reply.code(404).send({ error: 'Unknown pairing request.' });
      }

      if (outcome.status === 'approved') {
        // The one response that carries the token, and it carries it where the page
        // cannot read it. The id is still returned, because the browser addresses its
        // session by id and remembers which one it was looking at; on its own the id
        // proves nothing. See ADR-041.
        //
        // Secure is set only on a request that already arrived over TLS: the usual
        // deployment is a plain address on a home network, and a Secure cookie sent
        // there is one the browser discards.
        reply.header(
          'set-cookie',
          sessionCookie(outcome.session.token, request.protocol === 'https'),
        );

        return reply.send({ status: 'approved', sessionId: outcome.session.id });
      }

      return reply.send({ status: outcome.status });
    },
  );
}
