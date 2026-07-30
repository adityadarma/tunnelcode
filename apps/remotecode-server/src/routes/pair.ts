import type { FastifyInstance } from 'fastify';
import { pairRequestSchema } from '@remotecode/protocol';
import type { DeviceService } from '../services/device.js';
import type { SessionService } from '../services/session.js';
import type { CliRegistry } from '../ws/registry.js';

/** How many pair attempts a single client may make per window. */
const PAIR_MAX_ATTEMPTS = 10;
const PAIR_WINDOW = '1 minute';

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

  app.get('/pair/:requestId/status', async (request, reply) => {
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
      return reply.send({ status: 'approved', sessionId: outcome.session.id });
    }

    return reply.send({ status: outcome.status });
  });
}
