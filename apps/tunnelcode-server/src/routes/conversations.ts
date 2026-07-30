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
 * Conversation history routes.
 *
 * Every route is scoped to a session that exists, so a browser cannot read the
 * history of a session it never paired with by guessing ids.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRoutesOptions,
): void {
  const { conversationRepository, sessionRepository, devices } = options;

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

    if (conversationRepository.findById(conversationId) === undefined) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    // Activities travel with the messages so one request restores the whole
    // transcript, including what the engine did between the questions.
    return reply.send({
      messages: conversationRepository.listMessages(conversationId),
      activities: conversationRepository.listActivities(conversationId),
    });
  });

  app.delete('/conversations/:conversationId', (request, reply) => {
    const params = request.params as { conversationId?: string };
    const conversationId = params.conversationId;

    if (conversationId === undefined || conversationId === '') {
      return reply.code(400).send({ error: 'Missing conversation id.' });
    }

    const deleted = conversationRepository.delete(conversationId);

    if (!deleted) {
      return reply.code(404).send({ error: 'Unknown conversation.' });
    }

    return reply.send({ success: true });
  });
}
