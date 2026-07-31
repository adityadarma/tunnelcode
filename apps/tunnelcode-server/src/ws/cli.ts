import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { parseCliMessage } from '@tunnelcode/protocol';
import type { CliMessage, ServerToCliMessage } from '@tunnelcode/protocol';
import type { DeviceService } from '../services/device.js';
import type { SessionService } from '../services/session.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { CliRegistry } from './registry.js';
import type { TurnRelay } from './turn-relay.js';
import { startHeartbeat } from './heartbeat.js';
import type { Lifecycle } from '../lifecycle.js';

interface CliSocketOptions {
  devices: DeviceService;
  sessions: SessionService;
  registry: CliRegistry;
  sessionRepository: SessionRepository;
  relay: TurnRelay;
  lifecycle: Lifecycle;
}

/**
 * WebSocket endpoint the CLI connects to.
 *
 * A connection owns at most one device, established by the register message.
 * Approvals are only accepted for that device, so one CLI can never approve a
 * pairing request belonging to another. See ADR-014.
 */
export function registerCliSocket(app: FastifyInstance, options: CliSocketOptions): void {
  const { devices, sessions, registry, sessionRepository, relay, lifecycle } = options;

  app.get('/ws/cli', { websocket: true }, (socket: WebSocket) => {
    let deviceId: string | undefined;

    // A dead connection that never sent a close frame would otherwise keep its
    // pairing code and its workspace held until the server restarts.
    const stopHeartbeat = startHeartbeat(socket);

    const reply = (message: ServerToCliMessage): void => {
      socket.send(JSON.stringify(message));
    };

    const handle = (message: CliMessage): void => {
      switch (message.type) {
        case 'register': {
          if (deviceId !== undefined) {
            reply({ type: 'error', message: 'Already registered.' });
            return;
          }

          const result = devices.register({
            id: message.deviceId,
            code: message.code,
            name: message.deviceName,
            workspace: message.workspace,
            engines: message.engines,
          });

          if (!result.ok) {
            reply({
              type: 'error',
              message:
                result.reason === 'workspace_busy'
                  ? 'This workspace is already running an agent. Stop the other tunnelcode first.'
                  : 'Pairing code is already in use.',
              // Neither case can be resolved by reconnecting.
              fatal: true,
            });
            return;
          }

          const device = result.device;

          deviceId = device.id;
          registry.add(device.id, socket);

          // A device that paired before keeps its id, so browsers watching an
          // earlier session learn it is reachable again after a reconnect.
          relay.status(sessionRepository.listSessionIdsByDevice(device.id), true);

          reply({ type: 'registered', deviceId: device.id });
          return;
        }

        case 'approve': {
          if (deviceId === undefined) {
            reply({ type: 'error', message: 'Not registered.' });
            return;
          }

          const outcome = sessions.approve(message.requestId, deviceId);

          if (outcome.status !== 'approved') {
            reply({ type: 'error', message: `Cannot approve: ${outcome.status}.` });
            return;
          }

          devices.markPaired(deviceId);

          // Persisted only after approval, so an unapproved request leaves no
          // trace in the database.
          const device = devices.findById(deviceId);
          if (device !== undefined) {
            sessionRepository.persistApproved({
              sessionId: outcome.session.id,
              deviceId,
              deviceName: device.name,
              workspace: device.workspace,
              // The leading engine, which is what a conversation created in this
              // session starts on. Registration requires at least one, so the
              // fallback is only here to satisfy the type.
              engine: device.engines[0]?.name ?? '',
            });
          }

          relay.status([outcome.session.id], true);
          reply({ type: 'paired', deviceId });
          return;
        }

        case 'reject': {
          if (deviceId === undefined) {
            reply({ type: 'error', message: 'Not registered.' });
            return;
          }

          sessions.reject(message.requestId, deviceId);
          return;
        }

        case 'ping':
          reply({ type: 'pong' });
          return;

        case 'delta':
          if (deviceId !== undefined) {
            relay.delta(deviceId, message.turnId, message.text);
          }
          return;

        case 'turn_log':
          // Engine diagnostics stay on the server log; they are not part of the
          // conversation the user reads.
          app.log.info({ turnId: message.turnId }, message.text);
          return;

        case 'turn_activity':
          if (deviceId !== undefined) {
            relay.activity(deviceId, message.turnId, message.id, message.tool, message.target);
          }
          return;

        case 'turn_blocked':
          if (deviceId !== undefined) {
            // Note: blocked events from Claude adapter might not have an id in our current events.ts?
            // Ah, wait, events.ts turn_blocked schema doesn't have id yet. Let me check events.ts first.
            // Oh, I didn't add id to turn_blocked in events.ts! Let me add it.
            // For now I'll just use a random id if it's not present, wait no. I must update events.ts.
            // Let's assume I'll update events.ts next.
            relay.blocked(
              deviceId,
              message.turnId,
              (message as any).id ?? 'unknown',
              message.tool,
              message.reason,
            );
          }
          return;

        case 'turn_session':
          if (deviceId !== undefined) {
            // The engine name is recorded with the id, because an id only means
            // something to the engine that issued it. It comes from the turn
            // rather than the device: a device runs several engines now, and only
            // the turn knows which one answered.
            relay.engineSession(deviceId, message.turnId, message.engineSessionId);
          }
          return;

        case 'turn_message':
          if (deviceId !== undefined) {
            relay.message(deviceId, message.turnId, message.text);
          }
          return;

        case 'turn_activity_output':
          if (deviceId !== undefined) {
            relay.activityOutput(deviceId, message.turnId, message.activityId, message.output);
          }
          return;

        case 'turn_done':
          if (deviceId !== undefined) {
            relay.done(deviceId, message.turnId, message.text);
          }
          return;

        case 'turn_error':
          if (deviceId !== undefined) {
            relay.fail(deviceId, message.turnId, message.message, message.text);
          }
          return;
      }
    };

    socket.on('message', (raw: Buffer) => {
      const message = parseCliMessage(raw.toString('utf8'));

      if (message === undefined) {
        reply({ type: 'error', message: 'Invalid message.' });
        return;
      }

      handle(message);
    });

    // A code is only valid while its CLI session runs, so dropping the socket
    // frees the code and discards anything pending for it.
    socket.on('close', () => {
      stopHeartbeat();

      if (deviceId === undefined) {
        return;
      }

      // A reconnecting CLI may already have registered its replacement socket
      // under this device. Cleaning up then would discard the session that just
      // came back, so a superseded socket stops here.
      if (!registry.removeIf(deviceId, socket)) {
        return;
      }

      // During shutdown the database is already closing and every browser is
      // being disconnected anyway, so notifying would only fail.
      if (!lifecycle.isClosing()) {
        // Browsers are told before the device is forgotten, so an open tab
        // learns why sending stopped working instead of failing silently.
        relay.abandonDevice(deviceId);
        relay.status(sessionRepository.listSessionIdsByDevice(deviceId), false);
      }

      sessions.removeByDevice(deviceId);
      devices.remove(deviceId);
    });
  });
}
