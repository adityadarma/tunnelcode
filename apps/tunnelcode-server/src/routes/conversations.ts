import type { FastifyInstance } from 'fastify';
import { createConversationSchema, updateConversationSchema } from '@tunnelcode/protocol';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';

interface ConversationRoutesOptions {
  conversationRepository: ConversationRepository;
  sessionRepository: SessionRepository;
  devices: DeviceService;
}

/**
 * Header a browser proves its session with on the routes that name a conversation
 * rather than a session.
 *
 * A conversation id is not a credential. Without this, knowing one was enough to
 * read a whole transcript, which includes the output of every tool the agent ran:
 * file contents and command results from the user's machine.
 */
const SESSION_HEADER = 'x-tunnelcode-session';

type Authorized = { ok: true; sessionId: string } | { ok: false; status: number; error: string };

/**
 * Conversation history routes.
 *
 * The routes that name a session take it from the path, where holding the id is
 * the claim, exactly as the WebSocket treats it. The routes that name only a
 * conversation take the session from a header and check the conversation belongs
 * to it.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRoutesOptions,
): void {
  const { conversationRepository, sessionRepository, devices } = options;

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
  const authorize = (
    request: { headers: Record<string, unknown> },
    conversationId: string,
  ): Authorized => {
    const header = request.headers[SESSION_HEADER];
    const sessionId = typeof header === 'string' ? header : '';

    if (sessionId === '') {
      return { ok: false, status: 400, error: 'Missing session id.' };
    }

    // Rejects an ended session, since findSessionDetail leaves those out. A
    // retired pairing cannot be used to read anything.
    const caller = sessionRepository.findSessionDetail(sessionId);

    if (caller === undefined) {
      return { ok: false, status: 404, error: 'Unknown session.' };
    }

    const owner = sessionRepository.findSessionForConversation(conversationId);

    if (
      owner === undefined ||
      owner.deviceId !== caller.deviceId ||
      owner.workspace !== caller.workspace
    ) {
      return { ok: false, status: 404, error: 'Unknown conversation.' };
    }

    return { ok: true, sessionId };
  };

  app.get('/sessions/:sessionId/conversations', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const detail = sessionRepository.findSessionDetail(sessionId);

    if (detail === undefined) {
      return reply.code(404).send({ error: 'Unknown session.' });
    }

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
  app.post('/sessions/:sessionId/conversations', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    const detail = sessionRepository.findSessionDetail(sessionId);

    if (detail === undefined) {
      return reply.code(404).send({ error: 'Unknown session.' });
    }

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
    if (parsed.data.model !== undefined && !engine.models.includes(parsed.data.model)) {
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
  app.patch('/conversations/:conversationId', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    const allowed = authorize(request, conversationId);

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

      if (!engine.models.includes(parsed.data.model)) {
        return reply.code(400).send({ error: 'That model is not available on this engine.' });
      }
    }

    conversationRepository.setModel(conversationId, parsed.data.model);

    return reply.send({ ...conversation, model: parsed.data.model ?? null });
  });

  app.get('/conversations/:conversationId/messages', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    const allowed = authorize(request, conversationId);

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

  app.delete('/conversations/:conversationId', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    // Checked before the delete rather than after, so a conversation belonging to
    // someone else is never destroyed on the way to being refused.
    const allowed = authorize(request, conversationId);

    if (!allowed.ok) {
      return reply.code(allowed.status).send({ error: allowed.error });
    }

    const deleted = conversationRepository.delete(conversationId);

    if (!deleted) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    return reply.send({ success: true });
  });
}
