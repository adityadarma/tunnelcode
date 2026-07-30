import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { parseBrowserMessage } from '@tunnelcode/protocol';
import type { BrowserMessage, ServerToBrowserMessage } from '@tunnelcode/protocol';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';
import type { TurnService } from '../services/turn.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { CliRegistry } from './registry.js';

interface BrowserSocketOptions {
  devices: DeviceService;
  turns: TurnService;
  registry: CliRegistry;
  browsers: BrowserRegistry;
  sessionRepository: SessionRepository;
  conversationRepository: ConversationRepository;
}

/**
 * WebSocket endpoint the browser connects to.
 *
 * A connection has to attach to a session before anything else, and the session
 * must exist in the database, which only happens after the user approved the
 * pairing in the terminal. That is what stops a guessed session id from
 * reaching a device. See ADR-014.
 */
export function registerBrowserSocket(app: FastifyInstance, options: BrowserSocketOptions): void {
  const { devices, turns, registry, browsers, sessionRepository, conversationRepository } = options;

  app.get('/ws/browser', { websocket: true }, (socket: WebSocket) => {
    let sessionId: string | undefined;
    let deviceId: string | undefined;

    const reply = (message: ServerToBrowserMessage): void => {
      socket.send(JSON.stringify(message));
    };

    const attach = (id: string): void => {
      const detail = sessionRepository.findSessionDetail(id);

      if (detail === undefined) {
        reply({ type: 'error', message: 'Unknown session.' });
        return;
      }

      sessionId = detail.id;
      deviceId = detail.deviceId;
      browsers.add(detail.id, socket);

      // A turn outlives the socket that started it, so a browser that refreshed
      // mid-answer is told what is still running. Otherwise it would show an
      // idle composer and have its next prompt refused.
      const active = turns.findActiveForSession(detail.id);

      reply({
        type: 'attached',
        sessionId: detail.id,
        online: registry.isConnected(detail.deviceId),
        ...(active !== undefined
          ? { activeTurn: { conversationId: active.conversationId, turnId: active.id } }
          : {}),
      });
    };

    /**
     * Ends the session on the paired machine.
     *
     * The agent runs there, so clearing the browser alone would leave a terminal
     * waiting for a browser that already left. Marking the session ended keeps the
     * stored history while making the session unusable.
     */
    const endSession = (): void => {
      if (sessionId === undefined || deviceId === undefined) {
        reply({ type: 'error', message: 'Not attached to a session.' });
        return;
      }

      sessionRepository.markEnded(sessionId);
      registry.send(deviceId, { type: 'stop', reason: 'The browser disconnected.' });
    };

    const sendPrompt = (message: Extract<BrowserMessage, { type: 'prompt' }>): void => {
      if (sessionId === undefined || deviceId === undefined) {
        reply({ type: 'error', message: 'Not attached to a session.' });
        return;
      }

      if (conversationRepository.findById(message.conversationId) === undefined) {
        reply({ type: 'error', message: 'Unknown conversation.' });
        return;
      }

      const device = devices.findById(deviceId);

      if (device === undefined || !registry.isConnected(deviceId)) {
        reply({ type: 'error', message: 'The device is offline.' });
        return;
      }

      // A model the engine never reported is refused here, so the CLI is never
      // asked for something its engine cannot serve.
      if (message.model !== undefined && !device.models.includes(message.model)) {
        reply({ type: 'error', message: 'That model is not available on this device.' });
        return;
      }

      // Checked before storing, so a refused prompt does not end up in the
      // history as a question without an answer.
      if (turns.hasActiveForDevice(deviceId)) {
        reply({
          type: 'error',
          message: 'The previous answer is still running. It will appear here when it finishes.',
        });
        return;
      }

      // The prompt is stored before the answer starts, so a refresh mid-answer
      // still shows what was asked.
      const stored = conversationRepository.appendMessage(
        message.conversationId,
        'user',
        message.text,
      );

      browsers.broadcast(sessionId, {
        type: 'message',
        conversationId: message.conversationId,
        id: stored.id,
        role: 'user',
        content: stored.content,
        createdAt: stored.createdAt,
      });

      const turn = turns.start({
        sessionId,
        deviceId,
        conversationId: message.conversationId,
      });

      // Continuing the engine conversation is what gives the agent memory of
      // what was already said here. Only resumed when the same engine issued the
      // id, since an id means nothing to a different engine.
      const engineSession = conversationRepository.findEngineSession(message.conversationId);
      const resume =
        engineSession !== undefined && engineSession.engine === device.engine
          ? engineSession.id
          : undefined;

      registry.send(deviceId, {
        type: 'prompt',
        turnId: turn.id,
        text: message.text,
        ...(message.model !== undefined ? { model: message.model } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });
    };

    socket.on('message', (raw: Buffer) => {
      const message = parseBrowserMessage(raw.toString('utf8'));

      if (message === undefined) {
        reply({ type: 'error', message: 'Invalid message.' });
        return;
      }

      switch (message.type) {
        case 'attach':
          attach(message.sessionId);
          return;
        case 'prompt':
          sendPrompt(message);
          return;
        case 'disconnect':
          endSession();
          return;
        case 'ping':
          reply({ type: 'pong' });
          return;
      }
    });

    socket.on('close', () => {
      if (sessionId !== undefined) {
        browsers.remove(sessionId, socket);
      }
    });
  });
}
