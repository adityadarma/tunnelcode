import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp } from '../dist/app.js';
import type { FastifyInstance } from 'fastify';

export interface TestServer {
  baseUrl: string;
  app: FastifyInstance;
}

/**
 * Starts a real server on an ephemeral port with its own database.
 *
 * Port 0 lets the OS pick a free port, so tests never collide with a development
 * server or with each other. Logging is off because output would only add noise.
 */
export async function withServer<T>(run: (server: TestServer) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-int-'));
  const app = await buildApp({ logger: false, databaseFile: join(dir, 'test.sqlite') });

  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    return await run({ baseUrl: `http://127.0.0.1:${String(port)}`, app });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * Polls an observable server condition until it holds.
 *
 * Closing a socket from the test only sends a close frame; the server frees what
 * that connection held in its own close handler, later. Anything that depends on
 * the release has to watch for it rather than assume it already happened.
 */
export async function waitUntil(
  check: () => Promise<boolean>,
  describe: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await wait(25);
  }

  throw new Error(`Timed out waiting for ${describe}`);
}

/** Collects every frame a socket receives, so assertions can look back. */
export interface Recorder<T> {
  socket: WebSocket;
  events: T[];
  send: (message: unknown) => void;
  waitFor: (predicate: (events: T[]) => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

export async function connect<T>(baseUrl: string, path: string): Promise<Recorder<T>> {
  const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}${path}`);
  const events: T[] = [];

  socket.on('message', (raw: Buffer) => {
    events.push(JSON.parse(raw.toString('utf8')) as T);
  });

  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  return {
    socket,
    events,
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    // Polling beats a fixed sleep: the test finishes as soon as the condition
    // holds, and fails loudly instead of racing when it never does.
    waitFor: async (predicate, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (predicate(events)) {
          return;
        }
        await wait(25);
      }

      throw new Error(`Timed out waiting for events: ${JSON.stringify(events)}`);
    },
    close: () => {
      socket.close();
    },
  };
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/**
 * Header a browser proves its session with on the routes that name only a
 * conversation. A conversation id is not a credential.
 */
export const SESSION_HEADER = 'x-tunnelcode-session';

export async function patchJson(
  baseUrl: string,
  path: string,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(sessionId === undefined ? {} : { [SESSION_HEADER]: sessionId }),
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/**
 * POST with no body and no content-type, the way the browser sends a request that
 * carries everything in its path.
 *
 * Kept separate from postJson because sending `{}` would hide whether the route
 * actually tolerates an absent body.
 */
export async function postEmpty(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST' });
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function deleteJson(
  baseUrl: string,
  path: string,
  sessionId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    ...(sessionId === undefined ? {} : { headers: { [SESSION_HEADER]: sessionId } }),
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function getJson(
  baseUrl: string,
  path: string,
  sessionId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...(sessionId === undefined ? {} : { headers: { [SESSION_HEADER]: sessionId } }),
  });
  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}
