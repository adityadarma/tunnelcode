import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { parseCliMessage } from '@tunnelcode/protocol';
import type { CliMessage, ServerToCliMessage } from '@tunnelcode/protocol';
import { hashRunId, hashSessionToken } from '../services/ids.js';
import type { DeviceService } from '../services/device.js';
import type { RunApprovals } from '../services/run-approvals.js';
import type { SessionService } from '../services/session.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { PushForget } from './browser.js';
import type { CliRegistry } from './registry.js';
import type { TurnRelay } from './turn-relay.js';
import { startAuthTimeout } from './auth-timeout.js';
import { startHeartbeat } from './heartbeat.js';
import { requestResume } from './resume.js';
import type { Lifecycle } from '../lifecycle.js';

interface CliSocketOptions {
  devices: DeviceService;
  sessions: SessionService;
  registry: CliRegistry;
  browsers: BrowserRegistry;
  runs: RunApprovals;
  sessionRepository: SessionRepository;
  relay: TurnRelay;
  lifecycle: Lifecycle;
  /**
   * Told when a session is retired in the terminal, so a browser that asked to be
   * notified about this machine stops being. Optional, since a server without
   * notifications has nothing to forget. See ADR-045.
   */
  push?: PushForget;
  /** Shortened by tests, which cannot wait out the real one. */
  authTimeoutMs?: number;
}

/**
 * WebSocket endpoint the CLI connects to.
 *
 * A connection owns at most one device, established by the register message.
 * Approvals are only accepted for that device, so one CLI can never approve a
 * pairing request belonging to another. See ADR-014.
 */
export function registerCliSocket(app: FastifyInstance, options: CliSocketOptions): void {
  const { devices, sessions, registry, browsers, runs, sessionRepository, relay, lifecycle, push } =
    options;

  app.get('/ws/cli', { websocket: true }, (socket: WebSocket) => {
    let deviceId: string | undefined;

    // A dead connection that never sent a close frame would otherwise keep its
    // pairing code and its workspace held until the server restarts.
    const stopHeartbeat = startHeartbeat(socket);

    const reply = (message: ServerToCliMessage): void => {
      socket.send(JSON.stringify(message));
    };

    // Marked fatal because reconnecting changes nothing: a CLI that did not register
    // in time has nothing to retry, it has to register.
    const stopAuthTimeout = startAuthTimeout(
      socket,
      () => {
        reply({ type: 'error', message: 'Did not register in time.', fatal: true });
      },
      options.authTimeoutMs,
    );

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
            // Hashed on arrival, so the plain id is never held anywhere but this
            // frame. See ADR-043.
            ...(message.runId === undefined ? {} : { runIdHash: hashRunId(message.runId) }),
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

          stopAuthTimeout();

          const device = result.device;

          deviceId = device.id;
          registry.add(device.id, socket);

          // The code is what tells a restart from a reconnect: it is generated once
          // per CLI session and reused for every reconnect inside it. A new one means
          // a new process, which has agreed to nothing yet. See ADR-040.
          runs.start(device.id, device.code);

          // Sessions this very run already approved. A server that restarted has
          // forgotten them while the CLI in front of the user has not moved, so they
          // are reinstated from the row rather than asked about again: updating the
          // image should not cost every paired browser a trip to the terminal.
          // See ADR-043.
          if (device.runIdHash !== undefined) {
            for (const id of sessionRepository.listSessionIdsForRun(device.id, device.runIdHash)) {
              runs.allow(device.id, id);
            }
          }

          const known = sessionRepository.listSessionIdsByDevice(device.id);

          // A device that paired before keeps its id, so browsers watching an
          // earlier session learn it is reachable again after a reconnect.
          relay.status(known, true);

          // A browser is already sitting on one of these sessions, and after a
          // restart nobody has said it may still drive this machine. Asking here
          // rather than waiting for its next prompt means the phone shows the number
          // as soon as the terminal does, instead of refusing a prompt later.
          for (const id of known) {
            if (browsers.has(id) && !runs.isAllowed(device.id, id)) {
              requestResume({ deviceId: device.id, sessionId: id, sessions, registry, browsers });
            }
          }

          reply({ type: 'registered', deviceId: device.id });
          return;
        }

        case 'approve': {
          if (deviceId === undefined) {
            reply({ type: 'error', message: 'Not registered.' });
            return;
          }

          const outcome = sessions.approve(message.requestId, deviceId);

          // A browser from an earlier run may carry on. Nothing is created and the
          // pairing code is left claimable: this run did not spend it, and the code
          // on screen is still what a new browser would use. See ADR-040.
          if (outcome.status === 'resumed') {
            runs.allow(deviceId, outcome.sessionId);

            // The session belongs to this run now. Without moving it, a session that
            // survived a CLI restart would be asked about again after every server
            // restart that followed. See ADR-043.
            sessionRepository.setRunIdHash(
              outcome.sessionId,
              devices.findById(deviceId)?.runIdHash ?? null,
            );

            // The browser attaches again rather than being handed the attach payload
            // from here, so a resumed session and a fresh one arrive the same way.
            browsers.broadcast(outcome.sessionId, {
              type: 'resume_approved',
              sessionId: outcome.sessionId,
            });
            relay.status([outcome.sessionId], true);
            reply({ type: 'paired', deviceId });
            return;
          }

          if (outcome.status !== 'approved') {
            reply({ type: 'error', message: `Cannot approve: ${outcome.status}.` });
            return;
          }

          devices.markPaired(deviceId);

          // The run that paired a session has agreed to it by definition, so the
          // browser about to collect this session is not asked again.
          runs.allow(deviceId, outcome.session.id);

          // Persisted only after approval, so an unapproved request leaves no
          // trace in the database.
          const device = devices.findById(deviceId);
          if (device !== undefined) {
            sessionRepository.persistApproved({
              sessionId: outcome.session.id,
              deviceId,
              deviceName: device.name,
              workspace: device.workspace,
              // Only the hash is written down. The token itself stays in memory until
              // the browser collects it as a cookie. See ADR-041.
              tokenHash: hashSessionToken(outcome.session.token),
              // Which run agreed to this, so the agreement survives a restart of the
              // server without surviving the run. See ADR-043.
              runIdHash: device.runIdHash ?? null,
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

          const refused = sessions.reject(message.requestId, deviceId);

          // Refusing a resume answers "should this browser still have my machine",
          // and the answer has to hold from now on rather than only for this
          // connection. The stored conversations are kept; the session is not.
          if (refused.sessionId !== undefined) {
            sessionRepository.markEnded(refused.sessionId);
            // Refused for good, so a browser that had asked to be notified about this
            // machine stops being. See ADR-045.
            push?.forgetSession(refused.sessionId);
            browsers.broadcast(refused.sessionId, {
              type: 'resume_rejected',
              message: 'The terminal did not allow this browser to continue.',
            });
          }

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

        case 'reasoning_delta':
          if (deviceId !== undefined) {
            relay.reasoningDelta(deviceId, message.turnId, message.text);
          }
          return;

        case 'turn_reasoning':
          if (deviceId !== undefined) {
            relay.reasoning(deviceId, message.turnId, message.text);
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
            relay.blocked(deviceId, message.turnId, message.tool, message.reason);
          }
          return;

        case 'turn_permission_request':
          if (deviceId !== undefined) {
            relay.permissionRequest(deviceId, message.turnId, {
              permissionId: message.permissionId,
              tool: message.tool,
              title: message.title,
              ...(message.target !== undefined ? { target: message.target } : {}),
              ...(message.reason !== undefined ? { reason: message.reason } : {}),
              details: message.details,
              suggestions: message.suggestions,
            });
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
      stopAuthTimeout();

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
