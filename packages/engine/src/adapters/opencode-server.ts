import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolveCommand } from '../which.js';

const COMMAND = 'opencode';

/**
 * Configuration forced on the server so it raises permission asks instead of
 * deciding alone.
 *
 * Passed inline rather than written to disk, because the only config file the
 * server would read lives in the user's own project and putting one there would
 * change how their editor and their terminal behave too. See ADR-022.
 */
const ASK_EVERYTHING = JSON.stringify({
  // Every kind opencode has, named individually because it offers no catch-all.
  // A kind left out would keep its own default, and a default of allow would run
  // a tool call the user never saw.
  permission: {
    bash: 'ask',
    edit: 'ask',
    webfetch: 'ask',
    doom_loop: 'ask',
    external_directory: 'ask',
  },
});

/** How the server announces the port it picked. */
const LISTENING_PATTERN = /listening on (http:\/\/\S+)/i;

/** Long enough for a cold start, short enough that a failure is reported. */
const START_TIMEOUT_MS = 30_000;

export interface OpenCodeServerHandle {
  baseUrl: string;
  /** Ready-made Authorization header value for every request. */
  authorization: string;
  stop(): void;
}

export type StartOpenCodeServer = (cwd: string) => Promise<OpenCodeServerHandle>;

/**
 * Servers this process started, killed when it exits.
 *
 * A server outliving the CLI would keep an agent with access to the workspace
 * running with nothing watching it.
 */
const running = new Set<{ kill: () => void }>();
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) {
    return;
  }

  cleanupRegistered = true;

  const stopAll = (): void => {
    for (const server of running) {
      server.kill();
    }
    running.clear();
  };

  // exit covers a normal end; the signals cover Ctrl+C, which is how the CLI is
  // usually stopped. Killing a child is synchronous, so it is safe in an exit
  // handler.
  process.once('exit', stopAll);
  process.once('SIGINT', stopAll);
  process.once('SIGTERM', stopAll);
}

/**
 * Starts a headless opencode server for one workspace.
 *
 * A server rather than `opencode run`, because that command answers permission
 * asks itself and answers by rejecting them, which no wrapper can intercept.
 * See ADR-022.
 *
 * It listens on localhost with a password of its own. Without one, any process on
 * this machine could drive an agent that reads and writes the workspace, which is
 * a wider door than the feature needs.
 */
export async function startOpenCodeServer(cwd: string): Promise<OpenCodeServerHandle> {
  const resolved = await resolveCommand(COMMAND);

  if (resolved === undefined) {
    throw new Error(`Cannot find ${COMMAND} on PATH.`);
  }

  const password = randomBytes(24).toString('base64url');
  // Port 0 lets the operating system pick, so two workspaces never collide and
  // nothing has to guess what is free.
  const args = ['serve', '--port', '0', '--hostname', '127.0.0.1'];

  const command = resolved.isBatch ? 'cmd.exe' : resolved.path;
  const spawnArgs = resolved.isBatch ? ['/d', '/s', '/c', resolved.path, ...args] : args;

  const child = spawn(command, spawnArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: ASK_EVERYTHING,
    },
  });

  registerCleanup();
  const entry = {
    kill: () => {
      child.kill();
    },
  };
  running.add(entry);

  const stop = (): void => {
    running.delete(entry);
    child.kill();
  };

  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });

  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The opencode server did not report an address in time.'));
      }, START_TIMEOUT_MS);
      timer.unref();

      const settle = (outcome: () => void): void => {
        clearTimeout(timer);
        outcome();
      };

      // The address is printed on one of the two streams depending on version, so
      // both are read rather than guessing which.
      const onLine = (line: string): void => {
        const match = LISTENING_PATTERN.exec(line);

        if (match?.[1] !== undefined) {
          settle(() => {
            resolve(match[1] as string);
          });
        }
      };

      stdout.on('line', onLine);
      stderr.on('line', onLine);

      child.on('error', (error) => {
        settle(() => {
          reject(error);
        });
      });

      child.on('exit', (code) => {
        settle(() => {
          reject(new Error(`The opencode server exited with code ${String(code ?? 0)}.`));
        });
      });
    });

    return {
      baseUrl: baseUrl.replace(/\/$/, ''),
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  } finally {
    stdout.close();
    stderr.close();
  }
}
