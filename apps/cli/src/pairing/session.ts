import { SessionScanUnsupportedError, createEngine } from '@tunnelcode/engine';
import type { AvailableEngine, Engine } from '@tunnelcode/engine';
import { ceilingRefusing } from './antigravity-ceiling.js';
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
import { bold, cyanBold, dim, green, greenBold, red, yellow } from '../style.js';
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
  /**
   * Timeout overrides from the config file, in milliseconds.
   * When absent, hardcoded defaults are used.
   */
  timeouts?: {
    idleMs?: number;
    answerMs?: number;
    silenceMs?: number;
  };
}

/** Backoff between reconnect attempts, capped so it keeps retrying. */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;

/**
 * How long a resumable session is given to come back before the code is shown.
 *
 * A browser that is already open asks within a second of the CLI registering, so
 * this is only ever waited out when nobody is holding the session: a tab that was
 * closed, or a phone in a pocket. The code is what that user needs, and leaving the
 * terminal saying "waiting" forever would leave them with no way forward.
 */
const RESUME_WAIT_MS = 15 * 1000;

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
  /**
   * Whether the pairing code has been put on screen.
   *
   * Once for the whole session rather than once per connection: the code does not
   * change across reconnects, so printing it again would read as a second code.
   */
  invited: boolean;
  /** Cancels the wait for a resume, when something arrives before it runs out. */
  cancelResumeWait: (() => void) | undefined;
  /**
   * Whether an approval question is on screen right now.
   *
   * The server asks a returning browser's question before it answers register, so the
   * terminal can learn there is a resumable session while the user is already looking
   * at that session's number. Waiting for a browser that is standing at the door is
   * not something to announce, and the code that wait ends in must not appear over an
   * approved session.
   */
  approving: boolean;
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
 * Runs one pairing session: wait for a browser, ask the user to approve, then stay
 * connected until the session ends.
 *
 * The pairing code is generated once and reused across reconnects, because the
 * code is tied to this CLI session and the QR already shown must keep working.
 *
 * Nothing is shown until the server has answered, because until then the terminal
 * does not know which question to ask. A workspace whose session is still live has a
 * browser that comes back on a keypress, and a code put in front of that user is one
 * more thing on screen than the moment calls for. See ADR-053.
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

  // Rendered up front and held as text, so showing it later is a plain write rather
  // than an await inside a socket callback. It is pure string work and costs under a
  // millisecond, which is why it is not worth a spinner of its own.
  const qr = await renderQr(loginUrl);

  // Held in an object because these are only ever written from callbacks, which
  // the compiler cannot narrow through.
  const state: SessionState = {
    paired: false,
    stopping: false,
    fatal: undefined,
    close: undefined,
    wake: undefined,
    client: undefined,
    invited: false,
    cancelResumeWait: undefined,
    approving: false,
  };
  let delay = RECONNECT_MIN_MS;

  /**
   * Puts the code, the QR and the link on screen, once.
   *
   * Everything a browser needs to pair is here rather than spread across the
   * session: a user reading this has one thing to do, and the three forms of it are
   * the same instruction for a phone camera, a typed code and a click.
   */
  const invite = (): void => {
    if (state.invited) {
      return;
    }

    state.invited = true;
    state.cancelResumeWait?.();
    writeOut(qr);
    writeOut(`ℹ Pairing Code Generated: ${cyanBold(` ${code} `)}`);
    writeOut(`${dim('[Pairing]')} Open ${loginUrl}`);
    writeOut('');
    writeOut(`${yellow('⏳')} ${bold('Waiting for browser connection request...')}`);
  };

  /**
   * Says a session is waiting to be picked up, and shows the code if it is not.
   *
   * The timer is what keeps this from being a dead end. A browser that is open asks
   * to resume immediately, so the wait ends on its own; one that is closed never
   * asks, and the user is left needing exactly the code this was holding back.
   */
  const awaitResume = (count: number): void => {
    // A browser that is already paired, or one whose number is on screen waiting to
    // be approved, is not something to wait for: it is here. The server asks that
    // question before it answers register, so this runs with the approval prompt
    // already up, and starting the wait would end in a code being printed over a
    // session the user just resumed.
    if (state.invited || state.paired || state.approving || state.cancelResumeWait !== undefined) {
      return;
    }

    writeOut('');
    writeOut(
      `${yellow('⏳')} ${bold(
        `Waiting for ${count === 1 ? 'the paired browser' : `${String(count)} paired browsers`} to reconnect...`,
      )}`,
    );
    writeOut(`  ${dim('Open the session on your phone. Nothing to scan.')}`);

    const timer = setTimeout(() => {
      state.cancelResumeWait = undefined;

      // Checked again rather than trusted from when the timer was set: something
      // arrived in the meantime if a browser paired or is being approved right now,
      // and the code exists for the case where nobody did.
      if (state.paired || state.approving || state.stopping) {
        return;
      }

      writeOut('');
      writeOut(`${dim('[Pairing]')} Nothing reconnected, so here is the code for a new browser.`);
      invite();
    }, RESUME_WAIT_MS);

    // Not worth holding the event loop open: the socket is what keeps the process
    // alive, and a session ending mid-wait has nothing left to show a code for.
    timer.unref();

    state.cancelResumeWait = () => {
      clearTimeout(timer);
      state.cancelResumeWait = undefined;
    };
  };

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
    timeoutMs: options.timeouts?.idleMs,
    onExpired: () => {
      const minutes = Math.round((options.timeouts?.idleMs ?? 60 * 60 * 1000) / 60 / 1000);
      writeOut('');
      writeOut(
        `No conversation for ${String(minutes)} minute${minutes === 1 ? '' : 's'}. Ending the session.`,
      );
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
    silenceTimeoutMs: options.timeouts?.silenceMs,
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
      engineInstances: engines,
      invite,
      awaitResume,
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
  /** Engine instances keyed by name, used for session scanning callbacks. */
  engineInstances: Map<string, Engine>;
  /** Puts the pairing code on screen. Owned by the session, so it happens once. */
  invite: () => void;
  /** Announces that a live session may come back, and shows the code if it does not. */
  awaitResume: (count: number) => void;
}

/**
 * Holds one connection open until it closes. Returns whether it ever registered,
 * which decides how long to wait before trying again.
 */
async function runConnection(options: ConnectionOptions): Promise<boolean> {
  const { state, idle, runner, fileWatcher, engineInstances } = options;
  const local = { registered: false };

  const client = new PairingClient({
    url: options.socketUrl,
    code: options.code,
    runId: options.runId,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    workspace: options.workspace,
    version: readVersion(),
    answerTimeoutMs: options.timeouts?.answerMs,
    engines: options.engines.map((engine) => ({
      name: engine.name,
      label: engine.label,
      models: engine.models,
    })),

    onRegistered: (_deviceId, resumableSessions) => {
      local.registered = true;
      idle.start();

      if (state.paired) {
        writeOut(`${green('✔')} Reconnected.`);
        // Ensure the file watcher is running after a reconnect, since onPaired
        // does not fire again for sessions that were already paired.
        fileWatcher.start();
        return;
      }

      // The first thing the terminal knows about who might be waiting, and the only
      // point at which it can tell a first pairing from a workspace being picked back
      // up. A live session means a browser that already paired can carry on with a
      // keypress here, so the code is held back rather than shown. See ADR-053.
      if (resumableSessions > 0) {
        options.awaitResume(resumableSessions);
      } else {
        options.invite();
      }
    },

    onPrompt: async (turnId, text, engineName, model, resume) => {
      await runner.run(turnId, text, engineName, model, resume);
    },

    // Only write access, and only for this workspace. Running commands is not
    // grantable from the browser: the rule it needs is `command(*)`, which is
    // unscoped, and Antigravity cannot raise an ask mid-turn, so an engine holding
    // it would run anything with nobody able to see the question. That grant stays
    // in Setup, where the user is the one choosing it. See ADR-031.
    onGrantAndRetry: async (turnId, text, engineName, model, resume) => {
      const { allowWorkspaceWrites, workspaceWriteRule } = await import('@tunnelcode/engine');

      // The ceiling is checked here for the same reason the policy checks it before
      // a grant: a rule answered in this terminal outranks a tap on a phone. For the
      // other engines that happens in `settle`, but Antigravity raises no ask, so
      // this is where it has to happen. The turn is still retried, and the engine
      // refuses the call again with its reason unchanged, which is a truer answer
      // than pretending the grant landed. See ADR-022.
      const refusal = await ceilingRefusing(await workspaceWriteRule(options.workspace));

      if (refusal === undefined) {
        await allowWorkspaceWrites(options.workspace);
        writeOut('Granted write access from the browser.');
      } else {
        writeOut(
          `Never allow forbids ${refusal.denied}, so the grant from the browser was refused.`,
        );
      }

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
      // Somebody is at the door, so the wait for a returning browser is over. Without
      // this the code could land on screen in the middle of the approval prompt.
      state.cancelResumeWait?.();
      state.approving = true;

      try {
        const approved = await askApproval(approvalNumber);
        writeOut(
          approved
            ? `${green('✔')} ${greenBold('Approved! Session established.')}`
            : `${red('✗')} Rejected.`,
        );
        return approved;
      } finally {
        state.approving = false;
      }
    },

    // A browser that paired before this process started. Approving it does not
    // spend the code on screen: that code is still what a new browser would use.
    // See ADR-040.
    onResumeRequest: async (approvalNumber) => {
      // The browser this run was waiting for. Ends the wait rather than letting the
      // code appear underneath a question the user is answering.
      state.cancelResumeWait?.();
      // Held for the whole question, because register is answered after this is
      // asked: the wait this would otherwise start is a wait for the browser whose
      // number is on screen. See ADR-053.
      state.approving = true;

      try {
        const approved = await askApproval(approvalNumber, 'resume');
        writeOut(
          approved
            ? `${green('✔')} ${greenBold('Approved! Session resumed.')}`
            : `${red('✗')} Rejected. That browser has to pair again.`,
        );

        // Refused, so pairing is the only way back in and the code is what does it.
        // Held back until now because a resume needed nothing scanned.
        if (!approved) {
          writeOut('');
          options.invite();
        }

        return approved;
      } finally {
        state.approving = false;
      }
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
      // A wait that is still running has been answered by this: the browser it was
      // waiting for is connected, and the code that wait ends in would be an
      // instruction to pair a session that is already running.
      state.cancelResumeWait?.();
      idle.reset();
      fileWatcher.start();
      writeOut('');
      writeOut(`${green('✔')} ${greenBold('Device connected.')}`);
      writeOut(`  Prompts from the browser now run here. Press ${bold('Ctrl+C')} to stop.`);
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

    /**
     * Scans one engine's local history, or says why it cannot be scanned.
     *
     * Two of the answers here are empty lists, and they are not the same news. An
     * engine with no reader will never have sessions to offer, so it is reported
     * unsupported with a reason: telling the user "no sessions yet" would send them
     * off to make one and bring them back to the same empty modal. A scan that was
     * possible and broke stays supported and carries `error` instead, because that
     * one is worth a second tap. See the protocol notes on the two fields.
     */
    onListSessionsRequest: async (requestId, engineName, cwd) => {
      const engine = engineInstances.get(engineName);

      if (!engine?.listLocalSessions) {
        client.report({
          type: 'list_sessions_response',
          requestId,
          engine: engineName,
          sessions: [],
          supported: false,
          // The two cases read the same from here — no reader to call — but they are
          // different facts about the machine, and only one of them is the user's to
          // fix. An engine missing from the map was never registered by this CLI, so
          // there is nothing on this machine to read; one that is registered without a
          // reader is a gap on our side, and no amount of installing helps.
          reason:
            engine === undefined
              ? `${engineName} was not found on this machine, so it has no sessions to read here. Install it and start the session again.`
              : `${engine.label} sessions cannot be read yet, so there is nothing here to import. Start a new conversation instead.`,
        });
        return;
      }

      try {
        const sessions = await engine.listLocalSessions(cwd);
        client.report({
          type: 'list_sessions_response',
          requestId,
          engine: engineName,
          sessions,
          supported: true,
        });
      } catch (err) {
        // The reader exists and refused to run here, and it already said why in a
        // sentence meant for a person. Passed through as it stands: the detail that
        // makes it actionable belongs to the reader, and this code does not know it.
        if (err instanceof SessionScanUnsupportedError) {
          client.report({
            type: 'list_sessions_response',
            requestId,
            engine: engineName,
            sessions: [],
            supported: false,
            reason: err.message,
          });
          return;
        }

        // Still supported: this engine can be scanned here and this attempt failed,
        // which is what `error` means. Retrying it is not a waste of the user's tap.
        client.report({
          type: 'list_sessions_response',
          requestId,
          engine: engineName,
          sessions: [],
          supported: true,
          error: 'Failed to scan sessions.',
        });
      }
    },

    onImportSessionRequest: async (requestId, engineName, sessionId, cwd) => {
      const engine = engineInstances.get(engineName);
      if (!engine?.readSessionContent) {
        client.report({
          type: 'import_session_response',
          requestId,
          sessionId,
          engineSessionId: null,
          messages: [],
          activities: [],
          error: 'Engine does not support session import.',
        });
        return;
      }
      try {
        const content = await engine.readSessionContent(sessionId, cwd);
        client.report({
          type: 'import_session_response',
          requestId,
          sessionId,
          engineSessionId: content.engineSessionId,
          messages: content.messages,
          activities: content.activities,
        });
      } catch (err) {
        // A read that cannot run here arrives as a SessionScanUnsupportedError, whose
        // message is already the sentence to show. There is no `supported` field on
        // this response, so `error` is where it goes, and it is reported verbatim
        // rather than replaced by the generic line: an import that failed because the
        // reader needs a newer Node says so, instead of leaving the user guessing.
        client.report({
          type: 'import_session_response',
          requestId,
          sessionId,
          engineSessionId: null,
          messages: [],
          activities: [],
          error: err instanceof Error ? err.message : 'Failed to read session.',
        });
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
