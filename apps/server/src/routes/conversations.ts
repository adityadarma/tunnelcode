import type { FastifyInstance } from 'fastify';
import { createConversationSchema, updateConversationSchema } from '@tunnelcode/protocol';
import { authenticate } from '../session-auth.js';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { SessionDetail, SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';
import type { SessionImportService } from '../services/session-import.js';

/** Engines the system recognizes for import. */
const VALID_ENGINES = ['opencode', 'claude', 'antigravity', 'kiro', 'codex', 'copilot', 'cursor'];

interface ConversationRoutesOptions {
  conversationRepository: ConversationRepository;
  sessionRepository: SessionRepository;
  devices: DeviceService;
  sessionImport: SessionImportService;
}

type Authorized =
  { ok: true; caller: SessionDetail } | { ok: false; status: number; error: string };

/**
 * Conversation history routes.
 *
 * Every one of them works out who is calling from the session cookie. A path
 * carries an id, and an id is an address: knowing one used to be enough to read a
 * whole transcript, which includes the output of every tool the agent ran, meaning
 * file contents and command results from the user's machine. See ADR-041.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRoutesOptions,
): void {
  const { conversationRepository, sessionRepository, devices, sessionImport } = options;

  /**
   * Checks that the session presented in the header is entitled to a conversation.
   *
   * Entitlement is the workspace, not the session row. Pairing again creates a new
   * session for the same place, and its conversations are deliberately still
   * listed, so comparing ids alone would make history disappear after a reconnect.
   *
   * A conversation that exists but belongs elsewhere answers exactly like one that
   * does not exist, so the reply never confirms that an id is real.
   */
  const authorize = (cookie: string | undefined, conversationId: string): Authorized => {
    // Rejects an ended, idle or expired session as well as an unknown one: all of
    // them fail to resolve, which is the reading a retired pairing deserves.
    const caller = authenticate(sessionRepository, cookie);

    if (caller === undefined) {
      return { ok: false, status: 401, error: 'Not signed in.' };
    }

    const owner = sessionRepository.findSessionForConversation(conversationId);

    if (
      owner === undefined ||
      owner.deviceId !== caller.deviceId ||
      owner.workspace !== caller.workspace
    ) {
      return { ok: false, status: 404, error: 'Unknown conversation.' };
    }

    return { ok: true, caller };
  };

  /**
   * Resolves the caller for a route that names a session in its path.
   *
   * The path is checked against the cookie rather than trusted, so a request that
   * names somebody else's session is refused instead of being served because the
   * caller happens to hold a valid session of its own.
   */
  const authorizeSession = (cookie: string | undefined, sessionId: string): Authorized => {
    const caller = authenticate(sessionRepository, cookie);

    if (caller === undefined) {
      return { ok: false, status: 401, error: 'Not signed in.' };
    }

    if (caller.id !== sessionId) {
      return { ok: false, status: 404, error: 'Unknown session.' };
    }

    return { ok: true, caller };
  };

  app.get('/api/sessions/:sessionId/conversations', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const allowed = authorizeSession(request.headers.cookie, sessionId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const detail = allowed.caller;

    // Scoped to the workspace rather than the session, so pairing again reopens
    // the same list instead of an empty one. Still only reachable through a
    // session that exists, so this widens what a paired browser sees without
    // widening who can see it.
    const related = sessionRepository.listSessionIdsForWorkspace(detail.deviceId, detail.workspace);

    return reply.send({ conversations: conversationRepository.listBySessions(related) });
  });

  /**
   * Creates a conversation on one of the engines the device can run.
   *
   * The engine is fixed at creation because the agent's context lives in an engine
   * session; moving a conversation between engines would abandon it. The model is
   * optional and can be changed later. See ADR-020.
   */
  app.post('/api/sessions/:sessionId/conversations', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const allowed = authorizeSession(request.headers.cookie, sessionId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const detail = allowed.caller;
    const parsed = createConversationSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid engine or model.' });
    }

    const device = devices.findById(detail.deviceId);

    // A conversation is created to be used, and choosing its engine is only
    // meaningful against what the machine can actually run right now.
    if (device === undefined) {
      return reply.code(409).send({ error: 'The device is offline.' });
    }

    // Falls back to the leading engine, which is the one Setup named. That keeps a
    // client that does not choose working, without letting it pick blindly.
    const engineName = parsed.data.engine ?? device.engines[0]?.name;
    const engine =
      engineName === undefined ? undefined : devices.findEngine(detail.deviceId, engineName);

    if (engine === undefined) {
      return reply.code(400).send({ error: 'That engine is not available on this device.' });
    }

    // A model the engine never reported is refused here rather than at the first
    // prompt, so the conversation is never created in a state it cannot answer in.
    if (
      parsed.data.model !== undefined &&
      !engine.models.some((entry) => entry.id === parsed.data.model)
    ) {
      return reply.code(400).send({ error: 'That model is not available on this engine.' });
    }

    return reply
      .code(201)
      .send(conversationRepository.create(sessionId, engine.name, parsed.data.model));
  });

  /**
   * Changes the model of a conversation.
   *
   * Only the model: the engine is fixed for the life of the conversation, and a
   * different model of the same engine still understands its session.
   */
  app.patch('/api/conversations/:conversationId', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    const allowed = authorize(request.headers.cookie, conversationId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const parsed = updateConversationSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid model.' });
    }

    const conversation = conversationRepository.findById(conversationId);

    if (conversation === undefined) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    const detail = sessionRepository.findSessionForConversation(conversationId);

    if (detail === undefined) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    // Validated against the conversation's own engine, not the device default, so
    // a model that belongs to another installed engine is still refused.
    const engineName = conversation.engine ?? detail.engine;
    const engine = devices.findEngine(detail.deviceId, engineName);

    if (parsed.data.model !== undefined) {
      if (engine === undefined) {
        return reply.code(409).send({ error: 'The device is offline.' });
      }

      if (!engine.models.some((entry) => entry.id === parsed.data.model)) {
        return reply.code(400).send({ error: 'That model is not available on this engine.' });
      }
    }

    conversationRepository.setModel(conversationId, parsed.data.model);

    return reply.send({ ...conversation, model: parsed.data.model ?? null });
  });

  app.get('/api/conversations/:conversationId/messages', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    const allowed = authorize(request.headers.cookie, conversationId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    if (conversationRepository.findById(conversationId) === undefined) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    // Activities and thinking travel with the messages so one request restores the
    // whole transcript, including what the engine did between the questions and
    // what it was working out while it did.
    return reply.send({
      messages: conversationRepository.listMessages(conversationId),
      activities: conversationRepository.listActivities(conversationId),
      reasonings: conversationRepository.listReasonings(conversationId),
    });
  });

  app.delete('/api/conversations/:conversationId', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    // Checked before the delete rather than after, so a conversation belonging to
    // someone else is never destroyed on the way to being refused.
    const allowed = authorize(request.headers.cookie, conversationId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const deleted = conversationRepository.delete(conversationId);

    if (!deleted) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    return reply.send({ success: true });
  });

  /**
   * Lists agent sessions available on the paired CLI device for a given engine.
   *
   * The browser calls this to populate the "Continue from Agent" picker. The
   * server relays the request to the CLI, which scans local storage and reports
   * what it finds.
   */
  app.get('/api/sessions/:sessionId/agent-sessions', async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const allowed = authorizeSession(request.headers.cookie, sessionId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const detail = allowed.caller;
    const query = request.query as { engine?: string };
    const engine = query.engine;

    if (engine === undefined || engine === '') {
      return reply.code(400).send({ error: 'Engine name is required.' });
    }

    if (!VALID_ENGINES.includes(engine)) {
      return reply.code(400).send({ error: 'Invalid engine name.' });
    }

    const device = devices.findById(detail.deviceId);

    if (device === undefined) {
      return reply.code(409).send({ error: 'Device is offline.' });
    }

    try {
      const response = await sessionImport.listSessions(detail.deviceId, engine, detail.workspace);

      if (response.error) {
        if (response.error.toLowerCase().includes('not found')) {
          return await reply.code(404).send({ error: response.error });
        }
        return await reply.code(500).send({ error: response.error });
      }

      // `supported` and `reason` are relayed rather than dropped: an engine that
      // cannot be scanned at all returns the same empty list as one that was
      // scanned and held nothing, and only these two fields tell them apart. The
      // reason is passed through verbatim, since the CLI wrote it for a reader.
      return await reply.send({
        sessions: response.sessions,
        supported: response.supported,
        ...(response.reason !== undefined ? { reason: response.reason } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error.';

      if (message === 'Device is offline.') {
        return reply.code(409).send({ error: message });
      }
      if (message === 'Request timed out.') {
        return reply.code(504).send({ error: message });
      }

      return reply.code(500).send({ error: message });
    }
  });

  /**
   * Imports an agent session from the CLI into a new tunnelcode conversation.
   *
   * The browser calls this after the user picks a session from the listing. The
   * server fetches the full content from the CLI, creates a conversation, stores
   * all messages and activities with monotonic timestamps, and optionally records
   * the engine session id for native resume.
   */
  app.post('/api/sessions/:sessionId/conversations/import', async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const allowed = authorizeSession(request.headers.cookie, sessionId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const detail = allowed.caller;
    const body = request.body as { engine?: string; sessionId?: string } | null | undefined;

    if (body === undefined || body === null) {
      return reply.code(400).send({ error: 'Engine name and session id are required.' });
    }

    const engine = body.engine;
    const agentSessionId = body.sessionId;

    if (engine === undefined || engine === '') {
      return reply.code(400).send({ error: 'Engine name is required.' });
    }

    if (agentSessionId === undefined || agentSessionId === '') {
      return reply.code(400).send({ error: 'Session id is required.' });
    }

    if (!VALID_ENGINES.includes(engine)) {
      return reply.code(400).send({ error: 'Invalid engine name.' });
    }

    const device = devices.findById(detail.deviceId);

    if (device === undefined) {
      return reply.code(409).send({ error: 'Device is offline.' });
    }

    // Ensure the engine is actually available on the device.
    const deviceEngine = devices.findEngine(detail.deviceId, engine);

    if (deviceEngine === undefined) {
      return reply.code(400).send({ error: 'That engine is not available on this device.' });
    }

    try {
      const content = await sessionImport.importSession(
        detail.deviceId,
        engine,
        agentSessionId,
        detail.workspace,
      );

      if (content.error) {
        if (content.error.toLowerCase().includes('not found')) {
          return await reply.code(404).send({ error: content.error });
        }
        return await reply.code(500).send({ error: content.error });
      }

      // Create the conversation on the engine it was imported from.
      const conversation = conversationRepository.create(sessionId, engine);

      // Store imported messages and activities with monotonic timestamps to
      // preserve chronological order.
      const baseTime = Date.now() - (content.messages.length + content.activities.length) * 10;
      let offset = 0;

      for (const msg of content.messages) {
        conversationRepository.appendMessageWithTimestamp(
          conversation.id,
          msg.role,
          msg.content,
          baseTime + offset,
        );
        offset += 10;
      }

      // The engine's own tool-call id is deliberately not carried into the row:
      // reading the same session again replays it, and it would collide with the
      // rows the first import already wrote. See appendActivityWithTimestamp.
      for (const activity of content.activities) {
        conversationRepository.appendActivityWithTimestamp(
          conversation.id,
          activity.tool,
          activity.target ?? undefined,
          activity.output,
          baseTime + offset,
        );
        offset += 10;
      }

      // If the CLI reported a native session id, store it for resume.
      if (content.engineSessionId) {
        conversationRepository.setEngineSession(conversation.id, content.engineSessionId, engine);
      }

      // Re-read the conversation so the response includes the derived title.
      const stored = conversationRepository.findById(conversation.id) ?? conversation;

      return await reply.code(201).send(stored);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error.';

      if (message === 'Device is offline.') {
        return reply.code(409).send({ error: message });
      }
      if (message === 'Request timed out.') {
        return reply.code(504).send({ error: message });
      }

      return reply.code(500).send({ error: message });
    }
  });
}
