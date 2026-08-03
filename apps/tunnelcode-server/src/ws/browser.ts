import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { parseBrowserMessage } from '@tunnelcode/protocol';
import type { BrowserMessage, ServerToBrowserMessage } from '@tunnelcode/protocol';
import { authenticate } from '../session-auth.js';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { DeviceService } from '../services/device.js';
import type { PermissionService } from '../services/permission.js';
import type { RunApprovals } from '../services/run-approvals.js';
import type { SessionService } from '../services/session.js';
import type { TurnService } from '../services/turn.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { CliRegistry } from './registry.js';
import type { TurnRelay } from './turn-relay.js';
import { startAuthTimeout } from './auth-timeout.js';
import { requestResume } from './resume.js';

interface BrowserSocketOptions {
  devices: DeviceService;
  turns: TurnService;
  registry: CliRegistry;
  browsers: BrowserRegistry;
  sessions: SessionService;
  runs: RunApprovals;
  sessionRepository: SessionRepository;
  conversationRepository: ConversationRepository;
  permissions: PermissionService;
  relay: TurnRelay;
  /**
   * Told when a session is retired, so it stops holding an endpoint nothing will
   * ever send to. Optional, since a server without notifications has nothing to
   * forget. See ADR-045.
   */
  push?: PushForget;
  /** Shortened by tests, which cannot wait out the real one. */
  authTimeoutMs?: number;
}

/** The part of the push service this socket uses, kept narrow on purpose. */
export interface PushForget {
  forgetSession(sessionId: string): void;
}

/**
 * WebSocket endpoint the browser connects to.
 *
 * A connection has to attach to a session before anything else, and it is the
 * cookie sent with the handshake that decides which session that is. The session
 * must exist in the database, which only happens after the user approved the
 * pairing in the terminal, and the CLI run now connected must have agreed to serve
 * it. See ADR-014, ADR-040 and ADR-041.
 */
export function registerBrowserSocket(app: FastifyInstance, options: BrowserSocketOptions): void {
  const {
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
  } = options;

  app.get('/ws/browser', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    let sessionId: string | undefined;
    let deviceId: string | undefined;

    const reply = (message: ServerToBrowserMessage): void => {
      socket.send(JSON.stringify(message));
    };

    const stopAuthTimeout = startAuthTimeout(
      socket,
      () => {
        reply({ type: 'error', message: 'Did not attach in time.' });
      },
      options.authTimeoutMs,
    );

    const attach = (id: string): void => {
      // The cookie is the claim; the message only names which session it means. A
      // caller naming somebody else's session is answered exactly like one naming a
      // session that does not exist. See ADR-041.
      const detail = authenticate(sessionRepository, request.headers.cookie);

      if (detail === undefined || detail.id !== id) {
        reply({ type: 'error', message: 'Unknown session.' });
        return;
      }

      stopAuthTimeout();

      sessionId = detail.id;
      deviceId = detail.deviceId;
      browsers.add(detail.id, socket);

      // The session is real, but the CLI in front of the user is a run that has not
      // agreed to serve it: a restart is exactly the moment a session from before
      // should have to be allowed again. Registered above first, so the number
      // reaches this socket. An offline machine cannot be asked, and then attaching
      // is allowed as far as reading history goes: nothing can be done to the
      // machine while it is away, and the ask is raised the moment it registers.
      // See ADR-040.
      if (
        !runs.isAllowed(detail.deviceId, detail.id) &&
        requestResume({
          deviceId: detail.deviceId,
          sessionId: detail.id,
          sessions,
          registry,
          browsers,
        }) !== undefined
      ) {
        return;
      }

      // A turn outlives the socket that started it, so a browser that refreshed
      // mid-answer is told what is still running. Otherwise it would show an
      // idle composer and have its next prompt refused.
      const active = turns.findActiveForSession(detail.id);

      // What the engine has said so far and not yet stored. Sent with the turn so
      // a browser that was away while it streamed shows the answer in progress
      // rather than waiting on a blank indicator until the turn ends. See ADR-032.
      const pendingText = active === undefined ? '' : turns.textOf(active.id);

      reply({
        type: 'attached',
        sessionId: detail.id,
        online: registry.isConnected(detail.deviceId),
        ...(active !== undefined
          ? {
              activeTurn: {
                conversationId: active.conversationId,
                turnId: active.id,
                // Left out when nothing has streamed yet, so an answer that has
                // not started is not described as an empty one.
                ...(pendingText !== '' ? { pendingText } : {}),
              },
            }
          : {}),
      });

      // An ask that is still waiting is replayed to the browser that just
      // arrived. A phone that locked mid-turn is the ordinary case, and the engine
      // is holding still until one of these is answered. See ADR-022.
      for (const pending of permissions.listBySession(detail.id)) {
        reply(relay.askMessage(pending));
      }
    };

    /**
     * Applies what the user decided about an ask.
     *
     * The session doing the answering has to own the ask. Without that check a
     * guessed id would run a tool call on a machine the sender has no claim to,
     * which is worse than having no approval prompt at all. See ADR-022.
     */
    const decidePermission = (
      message: Extract<BrowserMessage, { type: 'permission_response' }>,
    ): void => {
      if (sessionId === undefined || deviceId === undefined) {
        reply({ type: 'error', message: 'Not attached to a session.' });
        return;
      }

      // An approval is the message a stolen session would most want to send, so the
      // run has to have agreed to this session before it can answer for the machine.
      // See ADR-040.
      if (!runs.isAllowed(deviceId, sessionId)) {
        reply({ type: 'error', message: 'Waiting for approval in the terminal.' });
        return;
      }

      const applied = relay.decidePermission(
        sessionId,
        message.conversationId,
        message.permissionId,
        message.decision,
      );

      // Also what a second tab sees when it answers a moment too late, so the
      // wording avoids blaming the user for a race they could not see.
      if (!applied) {
        reply({ type: 'error', message: 'That request is no longer waiting for an answer.' });
      }
    };

    /**
     * Stops the answer that is running.
     *
     * Gated exactly as a prompt is: stopping reaches into the machine and kills a
     * process there, so a session that may not prompt may not stop either.
     * See ADR-042.
     */
    const stopTurn = (message: Extract<BrowserMessage, { type: 'stop_turn' }>): void => {
      if (sessionId === undefined || deviceId === undefined) {
        reply({ type: 'error', message: 'Not attached to a session.' });
        return;
      }

      if (!runs.isAllowed(deviceId, sessionId)) {
        reply({ type: 'error', message: 'Waiting for approval in the terminal.' });
        return;
      }

      // Stopping is the user working, and the turn it ends may have been the only
      // thing keeping the session from going idle.
      sessionRepository.touch(sessionId);

      // The turn has to belong to this session's device, which is the same claim a
      // prompt has to make. Reported plainly rather than as an error: a tap that
      // lands just after the answer finished is the ordinary way this happens, and
      // the browser has already been told the turn is over.
      if (!relay.stop(deviceId, message.turnId)) {
        reply({ type: 'error', message: 'That answer is no longer running.' });
      }
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
      // Nothing can happen on this session again, so there is nothing left to
      // notify anybody about. See ADR-045.
      push?.forgetSession(sessionId);
      registry.send(deviceId, { type: 'stop', reason: 'The browser disconnected.' });
    };

    const sendPrompt = (message: Extract<BrowserMessage, { type: 'prompt' }>): void => {
      if (sessionId === undefined || deviceId === undefined) {
        reply({ type: 'error', message: 'Not attached to a session.' });
        return;
      }

      // A conversation id alone is not permission to prompt into it. Without this a
      // session could send work to another machine's conversation, which means
      // running an agent against a workspace it was never paired with.
      //
      // Judged exactly as the HTTP routes judge it: an ended session is absent from
      // findSessionDetail, and entitlement is the workspace rather than the session
      // row, so pairing again still reaches the same history. Two paths that disagree
      // here would leave one of them either a hole or a false refusal.
      const caller = sessionRepository.findSessionDetail(sessionId);

      if (caller === undefined) {
        reply({ type: 'error', message: 'Unknown session.' });
        return;
      }

      // Checked here as well as on attach, because a machine can come back while
      // this socket is attached: it registered under the same id, and until the
      // terminal says so it is not this browser's agent to use. See ADR-040.
      if (!runs.isAllowed(deviceId, sessionId)) {
        reply({ type: 'error', message: 'Waiting for approval in the terminal.' });
        return;
      }

      const owner = sessionRepository.findSessionForConversation(message.conversationId);

      if (
        owner === undefined ||
        owner.deviceId !== caller.deviceId ||
        owner.workspace !== caller.workspace
      ) {
        // Reported as unknown rather than forbidden, so the reply says nothing about
        // whether the conversation exists on some other device.
        reply({ type: 'error', message: 'Unknown conversation.' });
        return;
      }

      const conversation = conversationRepository.findById(message.conversationId);

      if (conversation === undefined) {
        reply({ type: 'error', message: 'Unknown conversation.' });
        return;
      }

      const device = devices.findById(deviceId);

      if (device === undefined || !registry.isConnected(deviceId)) {
        reply({ type: 'error', message: 'The device is offline.' });
        return;
      }

      // Read from the conversation rather than the message: the engine belongs to
      // the conversation, so two tabs cannot disagree about which one answers.
      // A conversation created before conversations had an engine falls back to the
      // one its session was paired with. See ADR-020.
      const engineName =
        conversation.engine ?? sessionRepository.findSessionDetail(sessionId)?.engine;
      const engine =
        engineName === undefined ? undefined : devices.findEngine(deviceId, engineName);

      // The engine was installed when the conversation was created but is not now.
      // Named in the message, because "offline" would send the user looking at the
      // wrong thing.
      if (engine === undefined) {
        reply({
          type: 'error',
          message: `Engine ${engineName ?? 'unknown'} is no longer available on this device.`,
        });
        return;
      }

      // A model the engine never reported is refused here, so the CLI is never
      // asked for something its engine cannot serve. This can happen without any
      // browser doing anything wrong: the engine may have dropped a model since the
      // conversation chose it.
      const model =
        conversation.model !== null && engine.models.includes(conversation.model)
          ? conversation.model
          : undefined;

      // Checked before storing, so a refused prompt does not end up in the
      // history as a question without an answer.
      if (turns.hasActiveForDevice(deviceId)) {
        reply({
          type: 'error',
          message: 'The previous answer is still running. It will appear here when it finishes.',
        });
        return;
      }

      // A question is the clearest activity there is, and it is what keeps the
      // session from going idle. Recorded here rather than on attach, because a
      // browser reconnecting is not somebody using the agent. See ADR-026.
      sessionRepository.touch(sessionId);

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
        // Recorded on the turn, because an engine session id reported later only
        // means something to the engine that issued it.
        engine: engine.name,
      });

      // Announced before the prompt is even sent, so the browser holds the turn id
      // from the start. An engine that says nothing at all is the case a stop button
      // is for, and until this the id only arrived with the first fragment of output.
      // See ADR-042.
      browsers.broadcast(sessionId, {
        type: 'turn_started',
        conversationId: message.conversationId,
        turnId: turn.id,
      });

      // Continuing the engine conversation is what gives the agent memory of
      // what was already said here. Only resumed when the same engine issued the
      // id, since an id means nothing to a different engine.
      const engineSession = conversationRepository.findEngineSession(message.conversationId);
      const resume =
        engineSession !== undefined && engineSession.engine === engine.name
          ? engineSession.id
          : undefined;

      registry.send(deviceId, {
        type: 'prompt',
        turnId: turn.id,
        text: message.text,
        engine: engine.name,
        ...(model !== undefined ? { model } : {}),
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
        case 'stop_turn':
          stopTurn(message);
          return;
        case 'permission_response':
          decidePermission(message);
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
      stopAuthTimeout();

      if (sessionId !== undefined) {
        browsers.remove(sessionId, socket);
      }
    });
  });
}
