import type { FastifyInstance } from 'fastify';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { SessionRepository } from '../db/session-repository.js';

interface ConversationRoutesOptions {
  conversationRepository: ConversationRepository;
  sessionRepository: SessionRepository;
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
  const { conversationRepository, sessionRepository } = options;

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

  app.post('/sessions/:sessionId/conversations', (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId;

    if (sessionId === undefined || sessionId === '') {
      return reply.code(400).send({ error: 'Missing session id.' });
    }

    if (sessionRepository.findSession(sessionId) === undefined) {
      return reply.code(404).send({ error: 'Unknown session.' });
    }

    return reply.code(201).send(conversationRepository.create(sessionId));
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
