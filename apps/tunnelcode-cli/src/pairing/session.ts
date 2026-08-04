import { createEngine } from '@tunnelcode/engine';
import type { AvailableEngine, Engine } from '@tunnelcode/engine';
import { Caffeinate } from './caffeinate.js';
import { PairingClient } from './client.js';
import { askApproval } from './approval.js';
import { buildCliSocketUrl, buildLoginUrl, generatePairingCode, generateRunId } from './code.js';
import { FileWatcher } from './file-watcher.js';
import { IdleTimer } from './idle.js';
import { createPermissionPolicy } from './permission-policy.js';
import { PromptRunner } from './prompt-runner.js';
import { renderQr } from './qr.js';
import { writeErr, writeOut } from '../output.js';
import { withSpinner } from '../spinner.js';
import { readVersion } from '../version.js';

export interface PairingSessionOptions {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  /**
   * Engines this machine can run, in the order the browser should see them.
   *
   * All of them are offered, because a conversation picks its own engine. See
   * ADR-020.
   */
  engines: AvailableEngine[];
}

/** Backoff between reconnect attempts, capped so it keeps retrying. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;

interface SessionState {
  paired: boolean;
  stopping: boolean;
  /** Set when retrying cannot help, which ends the session with an error. */
  fatal: string | undefined;
  /**
   * Closes the connection the session is currently waiting on.
   *
   * Ctrl+C arrives while that wait is in progress, so stopping has to reach the
   * socket: nothing else would ever end it.
   */
  close: (() => void) | undefined;
  /** Ends an in-progress reconnect delay, so stopping is not held up by it. */
  wake: (() => void) | undefined;
  /**
   * The connection engine output is reported on right now, if any.
   *
   * Read through this rather than captured, because a turn outlives the socket it
   * started on: the answer keeps arriving while the CLI reconnects, and it has to
   * reach whichever connection is current when it does. Undefined while there is no
   * connection, which drops the output rather than failing the turn. See ADR-044.
   */
  client: PairingClient | undefined;
}

/**
 * Waits, unless the session is stopped first.
 *
 * The reconnect delay grows to half a minute, so Ctrl+C during that wait has to
 * cut it short rather than leave the user watching a terminal that ignores them.
 */
const wait = async (ms: number, state: SessionState): Promise<void> => {
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      state.wake = undefined;
      resolve();
    };

    const timer = setTimeout(finish, ms);

    state.wake = () => {
      clearTimeout(timer);
      finish();
    };
  });
};

/**
 * Runs one pairing session: show the QR, wait for a browser, ask the user to
 * approve, then stay connected until the session ends.
 *
 * The pairing code is generated once and reused across reconnects, because the
 * code is tied to this CLI session and the QR already shown must keep working.
 *
 * Returns the process exit code.
 */
export async function runPairingSession(options: PairingSessionOptions): Promise<number> {
  const code = generatePairingCode();
  // Generated alongside the code and for the same lifetime: both belong to this run,
  // and both are reused across every reconnect it makes. See ADR-043.
  const runId = generateRunId();
  const loginUrl = buildLoginUrl(options.serverUrl, code);
  const socketUrl = buildCliSocketUrl(options.serverUrl);

  writeOut(await withSpinner('Generating...', () => renderQr(loginUrl)));
  writeOut(`Scan the QR or open  ${loginUrl}`);
  writeOut(`Pairing code         ${code}`);
  writeOut('');
  writeOut('Waiting for a browser to pair.');

  // Held in an object because these are only ever written from callbacks, which
  // the compiler cannot narrow through.
  const state: SessionState = {
    paired: false,
    stopping: false,
    fatal: undefined,
    close: undefined,
    wake: undefined,
    client: undefined,
  };
  let delay = RECONNECT_MIN_MS;

  /**
   * Marks the session as stopping and ends whatever it is waiting on.
   *
   * Setting the flag alone is not enough: the loop spends its time awaiting a
   * socket that only the peer would otherwise close, so the process would hang
   * with its connection still open and keep holding the pairing code.
   */
  const stop = (): void => {
    state.stopping = true;
    state.close?.();
    state.wake?.();
  };

  // Read through a function: the flag is only ever set from callbacks, and a
  // direct property read would be narrowed to its initial value.
  const shouldStop = (): boolean => state.stopping;

  // Both signals are handled because Ctrl+C reaches the CLI as SIGINT while a
  // package runner may follow it with SIGTERM. Announcing once keeps the second
  // one from repeating the message.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (!shouldStop()) {
        writeOut('');
        writeOut('Stopping.');
      }

      stop();
    });
  }

  /**
   * Ends the session after an hour with no conversation.
   *
   * One timer for the session rather than one per connection: it measures how long
   * nobody has used the agent, and a connection dropping is not somebody using it.
   * Built per connection, a reconnect handed the session a fresh hour. See ADR-044.
   */
  const idle = new IdleTimer({
    onExpired: () => {
      writeOut('');
      writeOut('No conversation for 1 hour. Ending the session.');
      stop();
    },
  });

  // Prevent the machine from sleeping while the session is active, so the tunnel
  // stays reachable without the user having to keep the screen awake manually.
  const caffeinate = new Caffeinate();
  caffeinate.start();

  // Built from the same list that was registered, so a prompt can only ever name an
  // engine this machine actually has. Adapters are stateless, so one instance per
  // engine is reused for every turn.
  const engines = new Map<string, Engine>();

  for (const available of options.engines) {
    const engine = createEngine(available.name);

    if (engine !== undefined) {
      engines.set(available.name, engine);
    }
  }

  /**
   * One runner for the session, not one per connection.
   *
   * A turn outlives the socket it started on: the engine keeps working while the CLI
   * reconnects. With a runner per connection, the reconnect brought a second runner
   * that believed the machine was free, so a prompt sent after the server came back
   * started a second engine in the same workspace while the first was still writing
   * to it. Output produced while there is no connection is dropped; whatever comes
   * after the reconnect reaches the server, which either still knows the turn or has
   * forgotten it. See ADR-044.
   */
  const runner = new PromptRunner({
    engines,
    cwd: options.workspace,
    send: (message) => {
      state.client?.report(message);
    },
    // Only messages reset the idle timeout, never heartbeats.
    onActivity: () => {
      idle.reset();
    },
    // Reads this machine's ceiling and its granted rules, so an ask the machine can
    // already answer never reaches the phone. See ADR-022.
    policy: createPermissionPolicy(),
  });

  /**
   * Watches git file changes in the workspace and sends them to browsers.
   *
   * Polls git status periodically so the file-changes page shows real-time workspace
   * state. Starts when paired, stops with the session.
   */
  const fileWatcher = new FileWatcher({
    cwd: options.workspace,
    send: (message) => {
      state.client?.report(message);
    },
  });

  while (!shouldStop()) {
    const connected = await runConnection({
      ...options,
      code,
      runId,
      socketUrl,
      state,
      stop,
      idle,
      runner,
      fileWatcher,
    });

    if (shouldStop() || state.fatal !== undefined) {
      break;
    }

    // A connection that worked resets the backoff, so a brief outage recovers
    // quickly while a server that stays down is not hammered.
    delay = connected ? RECONNECT_MIN_MS : Math.min(delay * 2, RECONNECT_MAX_MS);

    writeOut(`Connection lost. Reconnecting in ${String(Math.round(delay / 1000))}s.`);
    await wait(delay, state);

    // Ctrl+C during the delay ends the session rather than starting another
    // attempt.
    if (shouldStop()) {
      break;
    }
  }

  idle.stop();
  caffeinate.stop();
  fileWatcher.stop();

  // Stopped once, when the session is over, rather than on every disconnect. An
  // engine that runs a server of its own would otherwise have it killed by a network
  // blip, in the middle of the turn it was answering. Leaving it up past the session
  // is the thing to avoid: nothing would be watching an agent that can still reach
  // the workspace. See ADR-044.
  for (const engine of engines.values()) {
    engine.stop?.();
  }

  // The message was already written when it arrived, so printing it again here
  // would only duplicate it.
  if (state.fatal !== undefined) {
    return 1;
  }

  if (!state.paired) {
    writeOut('');
    writeOut('Session ended without pairing.');
  }

  return 0;
}

interface ConnectionOptions extends PairingSessionOptions {
  code: string;
  runId: string;
  socketUrl: string;
  state: SessionState;
  stop: () => void;
  /** Owned by the session, because it measures the session rather than the socket. */
  idle: IdleTimer;
  /** Owned by the session, because a turn outlives the connection. See ADR-044. */
  runner: PromptRunner;
  /** Watches git changes and reports them to the browser. */
  fileWatcher: FileWatcher;
}

/**
 * Holds one connection open until it closes. Returns whether it ever registered,
 * which decides how long to wait before trying again.
 */
async function runConnection(options: ConnectionOptions): Promise<boolean> {
  const { state, idle, runner, fileWatcher } = options;
  const local = { registered: false };

  const client = new PairingClient({
    url: options.socketUrl,
    code: options.code,
    runId: options.runId,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    workspace: options.workspace,
    version: readVersion(),
    engines: options.engines.map((engine) => ({ name: engine.name, models: engine.models })),

    onRegistered: () => {
      local.registered = true;
      idle.start();

      if (state.paired) {
        writeOut('Reconnected.');
        // Ensure the file watcher is running after a reconnect, since onPaired
        // does not fire again for sessions that were already paired.
        fileWatcher.start();
      }
    },

    onPrompt: async (turnId, text, engineName, model, resume) => {
      await runner.run(turnId, text, engineName, model, resume);
    },

    onPermissionResponse: (turnId, permissionId, decision, expired) => {
      runner.decide(turnId, permissionId, decision, expired);
    },

    // The engine is killed rather than asked to wind down: a turn worth stopping is
    // often one that is stuck. See ADR-042.
    onStopTurn: (turnId) => {
      writeOut('Stopping the current answer.');
      runner.stop(turnId);
    },

    onPairRequest: async (approvalNumber) => {
      const approved = await askApproval(approvalNumber);
      writeOut(approved ? 'Approved.' : 'Rejected.');
      return approved;
    },

    // A browser that paired before this process started. Approving it does not
    // spend the code on screen: that code is still what a new browser would use.
    // See ADR-040.
    onResumeRequest: async (approvalNumber) => {
      const approved = await askApproval(approvalNumber, 'resume');
      writeOut(approved ? 'Approved.' : 'Rejected. That browser has to pair again.');
      return approved;
    },

    onStop: (reason) => {
      writeOut('');
      writeOut(reason);
      writeOut('Session ended.');

      // The session is over, so reconnecting under the same code would only
      // rejoin a session the user already closed.
      options.stop();
      client.close();
    },

    onPaired: () => {
      state.paired = true;
      idle.reset();
      fileWatcher.start();
      writeOut('');
      writeOut('Device connected.');
      writeOut('Prompts from the browser now run here. Press Ctrl+C to stop.');
    },

    onError: (message, fatal) => {
      writeErr(message);

      // The server says whether retrying can help, so the CLI stops instead of
      // reconnecting and repeating the same failure forever.
      if (fatal) {
        state.fatal = message;
        options.stop();
        client.close();
      }
    },
  });

  // Where engine output goes from now on. Set before the wait, so a turn that was
  // still running when the last socket dropped reports the rest of itself here.
  state.client = client;

  // Registered before the wait, so Ctrl+C arriving mid-wait reaches this socket.
  // A signal that landed before this point is honoured by the check below.
  state.close = () => {
    client.close();
  };

  if (state.stopping) {
    client.close();
  }

  await client.waitUntilClosed();
  state.close = undefined;

  // Cleared rather than left pointing at a closed socket. A turn still in flight keeps
  // producing, and its output is dropped until the next connection sets this again.
  // See ADR-044.
  if (state.client === client) {
    state.client = undefined;
  }

  return local.registered;
}
