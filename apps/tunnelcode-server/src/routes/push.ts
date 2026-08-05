import type { FastifyInstance } from 'fastify';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from '@tunnelcode/protocol';
import { authenticate } from '../session-auth.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { PushService } from '../services/push.js';

interface PushRoutesOptions {
  push: PushService;
  sessionRepository: SessionRepository;
}

/**
 * Routes a browser uses to be reachable while it is closed.
 *
 * All of them work out who is calling from the session cookie, so a subscription is
 * always filed against the session that made it and can only be given up by that
 * session. A notification carries what the agent is asking about, so being able to
 * subscribe to somebody else's session would be being able to read it. See ADR-045.
 */
export function registerPushRoutes(app: FastifyInstance, options: PushRoutesOptions): void {
  const { push, sessionRepository } = options;

  /**
   * The application server key.
   *
   * Public by nature: the browser has to hand it to its push service to subscribe at
   * all. Still behind the cookie, because nothing else on this server answers to an
   * unpaired caller and there is no reason for this to be the exception.
   */
  app.get('/api/push/key', (request, reply) => {
    if (authenticate(sessionRepository, request.headers.cookie) === undefined) {
      return reply.code(401).send({ error: 'Not signed in.' });
    }

    return reply.send({ publicKey: push.publicKey() });
  });

  app.post('/api/push/subscribe', (request, reply) => {
    const caller = authenticate(sessionRepository, request.headers.cookie);

    if (caller === undefined) {
      return reply.code(401).send({ error: 'Not signed in.' });
    }

    const parsed = pushSubscriptionSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid subscription.' });
    }

    push.subscribe(caller.id, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });

    return reply.code(204).send();
  });

  /**
   * Forgets a subscription.
   *
   * Answers the same whether or not there was one to forget: a browser turning
   * notifications off has nothing to do with the answer, and a reply that
   * distinguished the two would report whether an endpoint is known.
   */
  app.post('/api/push/unsubscribe', (request, reply) => {
    const caller = authenticate(sessionRepository, request.headers.cookie);

    if (caller === undefined) {
      return reply.code(401).send({ error: 'Not signed in.' });
    }

    const parsed = pushUnsubscribeSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid subscription.' });
    }

    push.unsubscribe(caller.id, parsed.data.endpoint);

    return reply.code(204).send();
  });
}
