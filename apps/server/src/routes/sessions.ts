import type { FastifyInstance } from 'fastify';
import { authenticate } from '../session-auth.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';

interface SessionRoutesOptions {
  sessionRepository: SessionRepository;
  devices: DeviceService;
}

/**
 * Session detail route.
 *
 * Engines and their models come from the live device rather than the database,
 * because they describe what the currently running CLI can serve. A session whose
 * CLI has stopped reports none, which the UI shows as offline. See ADR-020.
 */
export function registerSessionRoutes(app: FastifyInstance, options: SessionRoutesOptions): void {
  const { sessionRepository, devices } = options;

  app.get('/api/sessions/:sessionId', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    // The cookie decides, and the path only says which session is being asked
    // about. See ADR-041.
    const caller = authenticate(sessionRepository, request.headers.cookie);

    if (caller === undefined) {
      return reply.code(401).send({ error: 'Not signed in.' });
    }

    // A caller asking about a session other than its own is answered exactly as one
    // asking about a session that does not exist, so the reply never confirms which
    // ids are real.
    if (caller.id !== sessionId) {
      return reply.code(404).send({ error: 'Unknown session.' });
    }

    const device = devices.findById(caller.deviceId);

    return reply.send({
      id: caller.id,
      deviceName: caller.deviceName,
      workspace: caller.workspace,
      // The engine a new conversation starts on, which is the one Setup named.
      engine: caller.engine,
      online: device !== undefined,
      // Every engine installed on the machine, each with its own models. A
      // conversation picks one of these when it is created.
      engines: device?.engines ?? [],
      // CLI version at pairing time, so the browser can compare.
      cliVersion: caller.cliVersion ?? null,
    });
  });
}
