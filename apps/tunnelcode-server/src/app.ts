import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ENGINE_TEXT_MAX_LENGTH } from '@tunnelcode/protocol';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { ConversationRepository } from './db/conversation-repository.js';
import { PushRepository } from './db/push-repository.js';
import { SessionRepository } from './db/session-repository.js';
import { DeviceService } from './services/device.js';
import { PushService } from './services/push.js';
import { RunApprovals } from './services/run-approvals.js';
import { SessionService } from './services/session.js';
import { TurnService } from './services/turn.js';
import { PermissionService } from './services/permission.js';
import { CliRegistry } from './ws/registry.js';
import { BrowserRegistry } from './ws/browser-registry.js';
import { TurnRelay } from './ws/turn-relay.js';
import { registerCliSocket } from './ws/cli.js';
import { registerBrowserSocket } from './ws/browser.js';
import { isAllowedOrigin } from './ws/origin.js';
import { registerPairRoutes } from './routes/pair.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerPushRoutes } from './routes/push.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerWeb, webRoot } from './web.js';
import { registerErrorHandler } from './errors.js';
import { registerSecurityHeaders } from './security-headers.js';
import { buildLoggerOptions } from './logging.js';
import { createLifecycle } from './lifecycle.js';

/** Global ceiling, so no single client can flood the server. */
const GLOBAL_MAX_REQUESTS = 100;
const GLOBAL_WINDOW = '1 minute';

/**
 * Largest WebSocket frame the server will read.
 *
 * Twice the longest text the protocol accepts, because JSON escaping can double a
 * string in the worst case and a legal message must never be dropped by the
 * transport. `ws` defaults to 100 MiB, which is an invitation nobody needs.
 */
const MAX_FRAME_BYTES = 2 * ENGINE_TEXT_MAX_LENGTH + 64 * 1024;

export interface AppOptions {
  /** False in tests, where log output would only add noise. */
  logger: boolean;
  databaseFile: string;
  /**
   * Whose forwarded headers to believe about the client address.
   *
   * Absent means nobody's. Fastify's own syntax otherwise: true for every hop, or
   * the proxy addresses to trust. See ADR-027.
   */
  trustProxy?: boolean | string;
  /**
   * How long a socket may stay open without identifying itself.
   *
   * Only set by tests, which cannot wait out the real one. The default lives with
   * the timeout itself.
   */
  authTimeoutMs?: number;
  /**
   * How long the server waits after a CLI socket closes before abandoning its turns.
   *
   * Only set by tests, which cannot wait out the real one. The default lives with
   * the constant in the CLI socket module.
   */
  reconnectGraceMs?: number;
  /**
   * Where log lines go.
   *
   * Only set by tests, which have to read what was written to assert that a
   * pairing code or a session id never reaches a log. Unset means stdout, which is
   * what a deployment collects.
   */
  logStream?: { write: (line: string) => void };
}

/**
 * Builds the server without listening, so tests can drive it directly.
 *
 * Realtime state lives in the in-memory services; SQLite only holds what has to
 * survive a restart. See ADR-006.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          ...buildLoggerOptions(),
          ...(options.logStream === undefined ? {} : { stream: options.logStream }),
        }
      : false,
    // Off unless a deployment says otherwise. Behind a proxy the client address
    // has to come from a forwarded header for the rate limit to tell clients
    // apart, but the server can also be reached directly, and then that header is
    // just something the client writes: a new value per request is a new identity,
    // and the pairing limit stops counting. See ADR-027.
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
  });

  registerErrorHandler(app);

  // Before every route, so the headers reach the responses a plugin sends as well
  // as the ones this app writes: a rate limited request and a static file are both
  // answers a browser applies a policy to.
  registerSecurityHeaders(app, { webRoot: webRoot() });

  const handle = openDb(options.databaseFile);
  runMigrations(handle.db);

  const sessionRepository = new SessionRepository(handle.db);
  const conversationRepository = new ConversationRepository(handle.db);
  const pushRepository = new PushRepository(handle.db);

  const registry = new CliRegistry();
  // A pairing code is only valid while its CLI session runs, so the device
  // service asks the registry whether a code still has a live connection behind
  // it before refusing a new one.
  const devices = new DeviceService({ isConnected: (id) => registry.isConnected(id) });
  const sessions = new SessionService();
  // What the CLI run in front of the user has agreed to serve. Memory only: a run
  // cannot outlive its process, so neither can its consent. See ADR-040.
  const runs = new RunApprovals();
  const turns = new TurnService();
  const browsers = new BrowserRegistry();
  // Waiting asks live here rather than in SQLite: one cannot outlive the turn it
  // belongs to, and a turn cannot outlive its CLI connection. See ADR-022.
  const permissions = new PermissionService();
  // Only reaches a browser that is not connected, which is why it is given the
  // registry: a page that is open shows an ask on the page. See ADR-045.
  const push = new PushService({
    repository: pushRepository,
    browsers,
    log: (message, error) => {
      app.log.warn({ err: error }, message);
    },
  });
  const relay = new TurnRelay({
    turns,
    browsers,
    conversationRepository,
    sessionRepository,
    permissions,
    devices,
    registry,
    push,
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
  await app.register(websocket, {
    options: {
      /**
       * Ceiling on a single frame, comfortably above the largest message the
       * protocol accepts and far below what `ws` allows by default.
       *
       * The schema is what decides whether a message is reasonable, but it only
       * gets to decide after the frame has been read and parsed. This is the limit
       * that applies before that, so a frame nobody would send never becomes a
       * string to hold in memory. See ADR-030.
       */
      maxPayload: MAX_FRAME_BYTES,
      /**
       * Refuses a handshake from a page that is not this server's own.
       *
       * Checked here rather than in a route handler because it has to be decided
       * before the upgrade: a socket that is already open has already bypassed
       * every HTTP-level protection, including the rate limit. See ADR-028.
       */
      verifyClient: ({ origin, req }, done) => {
        // The forwarded name is only worth reading when a proxy is trusted at all;
        // otherwise it is another header the client writes.
        const forwarded =
          options.trustProxy === undefined ? undefined : req.headers['x-forwarded-host'];

        done(
          isAllowedOrigin(origin, [
            req.headers.host,
            typeof forwarded === 'string' ? forwarded : undefined,
          ]),
          403,
          'Origin not allowed.',
        );
      },
    },
  });

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

  const authTimeout =
    options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs };
  const reconnectGrace =
    options.reconnectGraceMs === undefined ? {} : { reconnectGraceMs: options.reconnectGraceMs };

  registerCliSocket(app, {
    devices,
    sessions,
    registry,
    browsers,
    runs,
    sessionRepository,
    relay,
    lifecycle,
    push,
    ...authTimeout,
    ...reconnectGrace,
  });
  registerBrowserSocket(app, {
    devices,
    turns,
    registry,
    browsers,
    sessions,
    runs,
    sessionRepository,
    conversationRepository,
    permissions,
    relay,
    push,
    ...authTimeout,
  });
  registerPairRoutes(app, { devices, sessions, registry });
  registerSessionRoutes(app, { sessionRepository, devices });
  registerPushRoutes(app, { push, sessionRepository });
  await registerWeb(app);
  registerConversationRoutes(app, { conversationRepository, sessionRepository, devices });

  return app;
}
