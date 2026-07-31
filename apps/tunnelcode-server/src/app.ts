import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ConversationRepository } from './db/conversation-repository.js';
import { SessionRepository } from './db/session-repository.js';
import { DeviceService } from './services/device.js';
import { SessionService } from './services/session.js';
import { TurnService } from './services/turn.js';
import { PermissionService } from './services/permission.js';
import { CliRegistry } from './ws/registry.js';
import { BrowserRegistry } from './ws/browser-registry.js';
import { TurnRelay } from './ws/turn-relay.js';
import { registerCliSocket } from './ws/cli.js';
import { registerBrowserSocket } from './ws/browser.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerWeb } from './web.js';
import { registerErrorHandler } from './errors.js';
import { buildLoggerOptions } from './logging.js';
import { createLifecycle } from './lifecycle.js';

/** Global ceiling, so no single client can flood the server. */
const GLOBAL_MAX_REQUESTS = 100;
const GLOBAL_WINDOW = '1 minute';

export interface AppOptions {
  /** False in tests, where log output would only add noise. */
  logger: boolean;
  databaseFile: string;
}

/**
 * Builds the server without listening, so tests can drive it directly.
 *
 * Realtime state lives in the in-memory services; SQLite only holds what has to
 * survive a restart. See ADR-006.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ? buildLoggerOptions() : false,
    // Behind a proxy the client address comes from forwarded headers, which the
    // rate limit needs to tell clients apart.
    trustProxy: true,
  });

  registerErrorHandler(app);

  const handle = openDb(options.databaseFile);
  runMigrations(handle.db);

  const sessionRepository = new SessionRepository(handle.db);
  const conversationRepository = new ConversationRepository(handle.db);

  const registry = new CliRegistry();
  // A pairing code is only valid while its CLI session runs, so the device
  // service asks the registry whether a code still has a live connection behind
  // it before refusing a new one.
  const devices = new DeviceService({ isConnected: (id) => registry.isConnected(id) });
  const sessions = new SessionService();
  const turns = new TurnService();
  const browsers = new BrowserRegistry();
  // Waiting asks live here rather than in SQLite: one cannot outlive the turn it
  // belongs to, and a turn cannot outlive its CLI connection. See ADR-022.
  const permissions = new PermissionService();
  const relay = new TurnRelay({
    turns,
    browsers,
    conversationRepository,
    permissions,
    registry,
  });
  const lifecycle = createLifecycle();

  // Marked before anything is torn down, so socket close handlers know not to
  // touch the database that is about to be closed.
  app.addHook('preClose', () => {
    lifecycle.markClosing();
  });

  app.addHook('onClose', () => {
    handle.close();
  });

  await app.register(rateLimit, {
    max: GLOBAL_MAX_REQUESTS,
    timeWindow: GLOBAL_WINDOW,
  });
  await app.register(websocket);

  /**
   * Readiness probe. The database is actually queried rather than assumed
   * reachable, so a container that cannot read its volume reports unhealthy
   * instead of accepting traffic it cannot serve.
   */
  app.get('/health', (_request, reply) => {
    try {
      const knownDevices = sessionRepository.countDevices();

      return reply.send({
        status: 'ok',
        devices: devices.count(),
        knownDevices,
      });
    } catch (error) {
      app.log.error({ err: error }, 'Health check failed.');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  registerCliSocket(app, { devices, sessions, registry, sessionRepository, relay, lifecycle });
  registerBrowserSocket(app, {
    devices,
    turns,
    registry,
    browsers,
    sessionRepository,
    conversationRepository,
    permissions,
    relay,
  });
  registerPairRoutes(app, { devices, sessions, registry });
  registerSessionRoutes(app, { sessionRepository, devices });
  await registerWeb(app);
  registerConversationRoutes(app, { conversationRepository, sessionRepository, devices });

  return app;
}
