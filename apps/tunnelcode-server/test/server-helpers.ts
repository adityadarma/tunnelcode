import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { buildApp } from '../dist/app.js';
import type { FastifyInstance } from 'fastify';

export interface TestServer {
  baseUrl: string;
  app: FastifyInstance;
  /** Exposed so a test can read a column the API has no reason to report. */
  databaseFile: string;
}

/** Options a test needs to build a server that is not the default one. */
export interface ServerOptions {
  trustProxy?: boolean | string;
  /** Shortened so a test can watch an unauthenticated socket be dropped. */
  authTimeoutMs?: number;
  /**
   * Turns logging on and collects every line into this array.
   *
   * Absent leaves logging off, which is the default because output would only add
   * noise. Present is for the checks that assert on what a log does and does not
   * carry.
   */
  logLines?: string[];
}

/**
 * Starts a real server on an ephemeral port with its own database.
 *
 * Port 0 lets the OS pick a free port, so tests never collide with a development
 * server or with each other. Logging is off because output would only add noise.
 */
export async function withServer<T>(
  run: (server: TestServer) => Promise<T>,
  options: ServerOptions = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tunnelcode-int-'));
  const databaseFile = join(dir, 'test.sqlite');
  const lines = options.logLines;
  const app = await buildApp({
    logger: lines !== undefined,
    databaseFile,
    ...(lines === undefined
      ? {}
      : {
          logStream: {
            write: (line: string) => {
              lines.push(line);
            },
          },
        }),
    ...(options.trustProxy === undefined ? {} : { trustProxy: options.trustProxy }),
    ...(options.authTimeoutMs === undefined ? {} : { authTimeoutMs: options.authTimeoutMs }),
  });

  await app.listen({ host: '127.0.0.1', port: 0 });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const baseUrl = `http://127.0.0.1:${String(port)}`;

  try {
    return await run({ baseUrl, app, databaseFile });
  } finally {
    // A port is reused by the OS, so a cookie left behind could be sent to the next
    // server, which would be a session it never approved.
    jar.delete(baseUrl);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The session cookie each test server has handed out, per base URL.
 *
 * The credential is a cookie now, so the helpers have to behave like a browser:
 * keep what the server sets and send it back. Holding it here rather than threading
 * it through every call keeps a test about streaming from being a test about
 * authentication. A test that needs two identities uses the functions below to say
 * which one it means.
 */
const jar = new Map<string, string>();

function keepCookie(baseUrl: string, response: Response): void {
  const header = response.headers.get('set-cookie');

  if (header === null) {
    return;
  }

  const pair = header.split(';')[0];

  if (pair !== undefined && pair !== '') {
    jar.set(baseUrl, pair);
  }
}

function cookieHeader(baseUrl: string): Record<string, string> {
  const cookie = jar.get(baseUrl);
  return cookie === undefined ? {} : { cookie };
}

/** The cookie collected so far, for a test that has to hold on to one. */
export function currentCookie(baseUrl: string): string | undefined {
  return jar.get(baseUrl);
}

/** Puts a particular cookie back in play, so a test can act as an earlier session. */
export function useCookie(baseUrl: string, cookie: string | undefined): void {
  if (cookie === undefined) {
    jar.delete(baseUrl);
    return;
  }

  jar.set(baseUrl, cookie);
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

export async function connect<T>(
  baseUrl: string,
  path: string,
  /** Headers to send with the handshake, for the checks that read them. */
  headers: Record<string, string> = {},
): Promise<Recorder<T>> {
  const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}${path}`, {
    // The browser socket authenticates with the cookie sent on the handshake, so
    // the collected one travels unless a test says otherwise.
    headers: { ...cookieHeader(baseUrl), ...headers },
  });
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
  /** Extra headers, for the checks that read them rather than the body. */
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cookieHeader(baseUrl), ...headers },
    body: JSON.stringify(body),
  });

  keepCookie(baseUrl, response);

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function patchJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...cookieHeader(baseUrl) },
    body: JSON.stringify(body),
  });

  keepCookie(baseUrl, response);

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
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: cookieHeader(baseUrl),
  });

  keepCookie(baseUrl, response);

  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function deleteJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: cookieHeader(baseUrl),
  });

  keepCookie(baseUrl, response);

  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

export async function getJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: cookieHeader(baseUrl) });

  keepCookie(baseUrl, response);

  const text = await response.text();

  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}
