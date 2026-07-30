import type { Engine } from '@tunnelcode/engine';
import { PairingClient } from './client.js';
import { askApproval } from './approval.js';
import { buildCliSocketUrl, buildLoginUrl, generatePairingCode } from './code.js';
import { IdleTimer } from './idle.js';
import { PromptRunner } from './prompt-runner.js';
import { renderQr } from './qr.js';
import { writeErr, writeOut } from '../output.js';

export interface PairingSessionOptions {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  workspace: string;
  engine: Engine;
  models: string[];
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
  const loginUrl = buildLoginUrl(options.serverUrl, code);
  const socketUrl = buildCliSocketUrl(options.serverUrl);

  writeOut(await renderQr(loginUrl));
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

  while (!shouldStop()) {
    const connected = await runConnection({ ...options, code, socketUrl, state, stop });

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
  socketUrl: string;
  state: SessionState;
  stop: () => void;
}

/**
 * Holds one connection open until it closes. Returns whether it ever registered,
 * which decides how long to wait before trying again.
 */
async function runConnection(options: ConnectionOptions): Promise<boolean> {
  const { state } = options;
  const local = { registered: false };

  const idle = new IdleTimer({
    onExpired: () => {
      writeOut('');
      writeOut('No conversation for 1 hour. Ending the session.');
      options.stop();
      client.close();
    },
  });

  const client = new PairingClient({
    url: options.socketUrl,
    code: options.code,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    workspace: options.workspace,
    engine: options.engine.name,
    models: options.models,

    onRegistered: () => {
      local.registered = true;
      idle.start();

      if (state.paired) {
        writeOut('Reconnected.');
      }
    },

    onPrompt: async (turnId, text, model, resume) => {
      await runner.run(turnId, text, model, resume);
    },

    onPairRequest: async (approvalNumber) => {
      const approved = await askApproval(approvalNumber);
      writeOut(approved ? 'Approved.' : 'Rejected.');
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

  const runner = new PromptRunner({
    engine: options.engine,
    cwd: options.workspace,
    send: (message) => {
      client.report(message);
    },
    // Only messages reset the idle timeout, never heartbeats.
    onActivity: () => {
      idle.reset();
    },
  });

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
  idle.stop();

  return local.registered;
}
