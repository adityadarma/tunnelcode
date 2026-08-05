import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCommand } from '../which.js';

/**
 * A JSON-RPC id, which the specification allows to be either form.
 *
 * Kept as it arrived rather than normalised to a string: an answer has to carry
 * the id back exactly as it came, and a peer that numbered its request would not
 * recognise its own id quoted.
 */
export type RpcId = string | number;

export interface RpcError {
  code: number;
  message: string;
}

/** An incoming call that expects an answer. */
export interface RpcRequest {
  id: RpcId;
  method: string;
  params: unknown;
}

export interface RpcHandlers {
  /**
   * Answers a call from the agent. Returning a value answers it; throwing
   * refuses it.
   */
  onRequest(request: RpcRequest): Promise<unknown>;
  /** A one-way message from the agent, such as a session update. */
  onNotification(method: string, params: unknown): void;
  /** Diagnostics the agent wrote to stderr. */
  onStderr(line: string): void;
  /** The agent process ended, for whatever reason. */
  onExit(code: number): void;
}

export interface RpcConnection {
  /** Calls the agent and waits for its answer. Rejects when the agent refuses. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Tells the agent something without waiting. */
  notify(method: string, params: unknown): void;
  /** Ends the connection and the process behind it. */
  close(): void;
}

/** JSON-RPC code for a method this side does not implement. */
const METHOD_NOT_FOUND = -32601;

/** JSON-RPC code the agent uses to say the connection ended before an answer. */
const CONNECTION_CLOSED = -32000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** A JSON-RPC failure carrying the code, so a caller can tell auth from the rest. */
export class RpcFailure extends Error {
  readonly code: number;

  constructor(error: RpcError) {
    super(error.message);
    this.name = 'RpcFailure';
    this.code = error.code;
  }
}

interface Envelope {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Speaks JSON-RPC to a child process over stdio.
 *
 * The framing is one JSON object per line, which is what ACP uses over stdio and
 * what Codex's app server uses too. Deliberately not the Content-Length header
 * framing of the Language Server Protocol: the two look similar from a distance and
 * are not interchangeable.
 *
 * Shared by every adapter driven this way rather than copied per engine. It is
 * transport only: it knows nothing about sessions, prompts or permissions, so what
 * differs between two engines that agree on the framing stays in the adapter above
 * it rather than being duplicated underneath.
 */
export async function startJsonRpc(
  command: string,
  args: readonly string[],
  cwd: string,
  handlers: RpcHandlers,
): Promise<RpcConnection> {
  const resolved = await resolveCommand(command);

  if (resolved === undefined) {
    throw new Error(`Cannot find ${command} on PATH.`);
  }

  // Node refuses to execute Windows batch shims directly, which is how a CLI is
  // usually installed there. shell is never enabled, so arguments stay a list and
  // nothing can be injected through them.
  const target = resolved.isBatch ? 'cmd.exe' : resolved.path;
  const spawnArgs = resolved.isBatch ? ['/d', '/s', '/c', resolved.path, ...args] : [...args];

  const child = spawn(target, spawnArgs, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map<string, Pending>();
  let nextId = 1;
  let closed = false;

  const send = (message: unknown): void => {
    if (closed) {
      return;
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.stdin.on('error', () => {
    // The agent can exit before a write lands. The exit code already reports
    // that, so a lost write is not a second failure to announce.
  });

  const answer = (id: RpcId, request: RpcRequest): void => {
    void (async () => {
      try {
        send({ jsonrpc: '2.0', id, result: await handlers.onRequest(request) });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id,
          error: {
            code: METHOD_NOT_FOUND,
            message: error instanceof Error ? error.message : 'Request failed.',
          },
        });
      }
    })();
  };

  const stdout = createInterface({ input: child.stdout });

  stdout.on('line', (line) => {
    if (line.trim() === '') {
      return;
    }

    let message: Envelope;
    try {
      message = JSON.parse(line) as Envelope;
    } catch {
      // The agent prints its own diagnostics on stdout on some versions. A line
      // that is not JSON is not a protocol violation worth failing the turn for.
      return;
    }

    const id = message.id;
    const hasId = typeof id === 'string' || typeof id === 'number';

    // A call from the agent: it has both an id to answer and a method to run.
    if (hasId && typeof message.method === 'string') {
      answer(id, { id, method: message.method, params: message.params });
      return;
    }

    // A notification carries a method and no id, so nothing is expected back.
    if (!hasId && typeof message.method === 'string') {
      handlers.onNotification(message.method, message.params);
      return;
    }

    if (!hasId) {
      return;
    }

    const waiting = pending.get(String(id));

    if (waiting === undefined) {
      return;
    }

    pending.delete(String(id));

    if (message.error !== undefined) {
      const code = typeof message.error.code === 'number' ? message.error.code : 0;
      const text =
        typeof message.error.message === 'string' ? message.error.message : 'The agent refused.';
      waiting.reject(new RpcFailure({ code, message: text }));
      return;
    }

    waiting.resolve(message.result);
  });

  const stderr = createInterface({ input: child.stderr });

  stderr.on('line', (line) => {
    if (line.trim() !== '') {
      handlers.onStderr(line);
    }
  });

  /**
   * Fails everything still waiting.
   *
   * Without this a caller awaiting an answer would wait for a process that has
   * already gone, and the turn would hang rather than report what happened.
   */
  const abandon = (message: string): void => {
    for (const [, waiting] of pending) {
      waiting.reject(new RpcFailure({ code: CONNECTION_CLOSED, message }));
    }
    pending.clear();
  };

  child.on('error', (error) => {
    closed = true;
    abandon(error.message);
    handlers.onExit(1);
  });

  child.on('close', (code) => {
    closed = true;
    abandon('The agent ended before answering.');
    handlers.onExit(code ?? 0);
  });

  return {
    request: async (method, params) =>
      new Promise<unknown>((resolve, reject) => {
        if (closed) {
          reject(new RpcFailure({ code: CONNECTION_CLOSED, message: 'The agent is not running.' }));
          return;
        }

        const id = nextId++;
        pending.set(String(id), { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      }),
    notify: (method, params) => {
      send({ jsonrpc: '2.0', method, params });
    },
    close: () => {
      closed = true;
      stdout.close();
      stderr.close();
      child.stdin.end();
      child.kill();
    },
  };
}
