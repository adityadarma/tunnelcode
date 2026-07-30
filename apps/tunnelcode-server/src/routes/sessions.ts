import type { FastifyInstance } from 'fastify';
import type { SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';

interface SessionRoutesOptions {
  sessionRepository: SessionRepository;
  devices: DeviceService;
}

/**
 * Session detail route.
 *
 * Models come from the live device rather than the database, because they
 * describe what the currently running CLI can serve. A session whose CLI has
 * stopped reports no models, which the UI shows as offline.
 */
export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { sessionRepository, devices } = options;

  app.get('/sessions/:sessionId', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const detail = sessionRepository.findSessionDetail(sessionId);

    if (detail === undefined) {
      return reply.code(404).send({ error: 'Unknown session.' });
    }

    const device = devices.findById(detail.deviceId);

    return reply.send({
      id: detail.id,
      deviceName: detail.deviceName,
      workspace: detail.workspace,
      engine: detail.engine,
      online: device !== undefined,
      models: device?.models ?? [],
    });
  });
}
