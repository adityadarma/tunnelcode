import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { homeEnv } from './helpers.ts';

/**
 * What the terminal puts on screen depends on whether anybody can come back.
 *
 * These spawn the real CLI, because the decision is made from the server's answer to
 * register: it cannot be reached without a socket, and the thing being checked is the
 * output a user reads. See ADR-053.
 */

/** Fake engine, so the CLI gets past its availability check. */
const FAKE_ENGINE = `#!/usr/bin/env node
if (process.argv[2] === 'models') { process.stdout.write('opencode/fast\\n'); process.exit(0); }
process.stdin.resume();
`;

interface Fixture {
  home: string;
  binDir: string;
}

async function withFixture<T>(
  serverUrl: string,
  run: (fixture: Fixture) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-invite-home-'));
  const binDir = await mkdtemp(join(tmpdir(), 'tunnelcode-invite-bin-'));

  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'opencode.js'), FAKE_ENGINE, 'utf8');
    await writeFile(join(binDir, 'opencode.cmd'), '@node "%~dp0opencode.js" %*\r\n', 'utf8');
  } else {
    const enginePath = join(binDir, 'opencode');
    await writeFile(enginePath, FAKE_ENGINE, 'utf8');
    await chmod(enginePath, 0o755);
  }

  const configDir =
    process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming', 'TunnelCode')
      : join(home, '.config', 'tunnelcode');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'tunnelcode.json'),
    JSON.stringify({
      server: { url: serverUrl },
      device: { name: 'Test Mac' },
      engine: 'opencode',
    }),
    'utf8',
  );

  try {
    return await run({ home, binDir });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

function startCli(fixture: Fixture): ChildProcess {
  const child = spawn(process.execPath, ['./dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...homeEnv(fixture.home),
      PATH: `${fixture.binDir}${delimiter}${process.env['PATH'] ?? ''}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Left open: closing it would end the menu's line reader, and a closed stdin
  // reads as a refusal.
  child.stdin?.write('1\n');

  return child;
}

/**
 * Collects everything the CLI writes, and resolves once `pattern` appears.
 *
 * The whole transcript is handed back, because these tests are as interested in what
 * is absent as in what is there.
 */
async function readUntil(child: ChildProcess, pattern: RegExp): Promise<string> {
  return await collect(child).until(pattern);
}

/**
 * Everything the CLI has written so far, and a way to wait for more.
 *
 * Attached once per child and remembered on it, because a test that waits twice is
 * still reading one transcript: listeners added for the second wait would start from
 * empty and miss a line that had already gone by.
 */
interface Collector {
  readonly text: () => string;
  readonly until: (pattern: RegExp) => Promise<string>;
}

const collectors = new WeakMap<ChildProcess, Collector>();

function collect(child: ChildProcess): Collector {
  const existing = collectors.get(child);

  if (existing !== undefined) {
    return existing;
  }

  let seen = '';
  const waiters = new Set<(text: string) => void>();

  const onData = (chunk: Buffer): void => {
    seen += chunk.toString('utf8');

    for (const notify of [...waiters]) {
      notify(seen);
    }
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const collector: Collector = {
    text: () => seen,
    until: async (pattern) =>
      await new Promise<string>((resolve, reject) => {
        const finish = (text: string): void => {
          if (!pattern.test(text)) {
            return;
          }

          clearTimeout(timer);
          waiters.delete(finish);
          resolve(text);
        };

        const timer = setTimeout(() => {
          waiters.delete(finish);
          reject(new Error(`Timed out waiting for ${String(pattern)}. Saw: ${seen}`));
        }, 20000);

        waiters.add(finish);
        // Checked against what is already there, so a line that arrived before this
        // wait started still counts.
        finish(seen);
      }),
  };

  collectors.set(child, collector);
  return collector;
}

/**
 * A server that registers the device and reports the given number of live sessions,
 * which is the one fact the terminal decides from.
 */
async function withServer<T>(
  resumableSessions: number | undefined,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = new WebSocketServer({ port: 0, path: '/ws/cli' });
  const sockets: WebSocket[] = [];

  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', () => {
      socket.send(
        JSON.stringify({
          type: 'registered',
          deviceId: 'device-1',
          ...(resumableSessions === undefined ? {} : { resumableSessions }),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    return await run(`http://127.0.0.1:${String(port)}`);
  } finally {
    for (const socket of sockets) {
      socket.terminate();
    }
    server.close();
  }
}

test('a workspace nobody has paired shows the code, the QR and the link', async () => {
  await withServer(0, async (url) => {
    await withFixture(url, async (fixture) => {
      const child = startCli(fixture);

      try {
        const output = await readUntil(child, /Waiting for browser connection/);

        assert.match(output, /Pairing Code Generated/);
        assert.match(output, /\/login\?code=[A-Z]{8}/);
        // The QR is drawn out of block glyphs, so its presence is checked by them
        // rather than by any wording around it.
        assert.match(output, /[\u2580-\u259f]/u);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

test('a workspace with a live session waits for it instead of offering a code', async () => {
  await withServer(1, async (url) => {
    await withFixture(url, async (fixture) => {
      const child = startCli(fixture);

      try {
        // Waited on the last line of the wait notice rather than its heading, which
        // is written separately and can arrive in a chunk of its own. Waiting on the
        // heading passed or failed on whether stdout happened to flush both at once.
        const output = await readUntil(child, /Nothing to scan/);

        // The browser holds the session already. A code, a link and a QR are three
        // ways to do something it has no need to do. See ADR-053.
        assert.doesNotMatch(output, /Pairing Code Generated/);
        assert.doesNotMatch(output, /\/login\?code=/);
        assert.doesNotMatch(output, /[\u2580-\u259f]/u);
        assert.match(output, /Waiting for the paired browser to reconnect/);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

/**
 * A resumed session must never end up with a pairing code under it.
 *
 * The order here is the one that caused it: the ask arrives before the answer to
 * register, so the terminal learns there is a session to wait for while the browser
 * holding it is already at the door. The wait that started then ran to its end and
 * printed a code for a session that was connected and working.
 */
test('a browser approved while registering does not get a code printed after it', async () => {
  const server = new WebSocketServer({ port: 0, path: '/ws/cli' });
  const sockets: WebSocket[] = [];

  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as { type: string };

      if (message.type === 'register') {
        socket.send(
          JSON.stringify({
            type: 'resume_request',
            requestId: 'request-1',
            approvalNumber: '1588',
          }),
        );
        socket.send(
          JSON.stringify({ type: 'registered', deviceId: 'device-1', resumableSessions: 1 }),
        );
        return;
      }

      if (message.type === 'approve') {
        socket.send(JSON.stringify({ type: 'paired', deviceId: 'device-1' }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    await withFixture(`http://127.0.0.1:${String(port)}`, async (fixture) => {
      const child = startCli(fixture);

      try {
        await readUntil(child, /Reconnect request/);
        child.stdin?.write('y\n');
        const output = await readUntil(child, /Device connected/);

        // The announcement and the timer that prints the code are created together,
        // so a transcript without the announcement cannot grow a code later.
        assert.doesNotMatch(output, /Waiting for the paired browser to reconnect/);
        assert.doesNotMatch(output, /Pairing Code Generated/);
        assert.doesNotMatch(output, /Nothing reconnected/);
      } finally {
        child.kill('SIGKILL');
      }
    });
  } finally {
    for (const socket of sockets) {
      socket.terminate();
    }
    server.close();
  }
});

test('a server too old to report live sessions still shows the code', async () => {
  await withServer(undefined, async (url) => {
    await withFixture(url, async (fixture) => {
      const child = startCli(fixture);

      try {
        // Absent reads as none, which is the behaviour that was there before the
        // field existed rather than a terminal waiting on nobody.
        const output = await readUntil(child, /Waiting for browser connection/);

        assert.match(output, /Pairing Code Generated/);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
});

/** Fake opencode whose model listing answers only after a short delay. */
const SLOW_ENGINE = `#!/usr/bin/env node
if (process.argv[2] === 'models' && process.argv[3] === '--verbose') {
  setTimeout(() => {
    process.stdout.write('opencode/fast\\n');
    process.stdout.write(JSON.stringify({ id: 'fast', providerID: 'opencode', name: 'Fast' }, null, 2) + '\\n');
    process.exit(0);
  }, 200);
  return;
}
process.stdin.resume();
`;

async function withSlowFixture<T>(
  serverUrl: string,
  run: (fixture: Fixture) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-invite-home-'));
  const binDir = await mkdtemp(join(tmpdir(), 'tunnelcode-invite-bin-'));

  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'opencode.js'), SLOW_ENGINE, 'utf8');
    await writeFile(join(binDir, 'opencode.cmd'), '@node "%~dp0opencode.js" %*\r\n', 'utf8');
  } else {
    const enginePath = join(binDir, 'opencode');
    await writeFile(enginePath, SLOW_ENGINE, 'utf8');
    await chmod(enginePath, 0o755);
  }

  const configDir =
    process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming', 'TunnelCode')
      : join(home, '.config', 'tunnelcode');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'tunnelcode.json'),
    JSON.stringify({
      server: { url: serverUrl },
      device: { name: 'Test Mac' },
      engine: 'opencode',
    }),
    'utf8',
  );

  try {
    return await run({ home, binDir });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

/**
 * The pairing code must not wait on a model list that is slow to arrive, and the
 * models it was missing have to reach the server on their own once they are ready.
 */
test('register goes out with no models yet, and engines_updated fills them in', async () => {
  const server = new WebSocketServer({ port: 0, path: '/ws/cli' });
  const sockets: WebSocket[] = [];
  const received: { type: string; engines?: { name: string; models: unknown[] }[] }[] = [];

  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString('utf8')) as {
        type: string;
        engines?: { name: string; models: unknown[] }[];
      };
      received.push(message);

      if (message.type === 'register') {
        socket.send(JSON.stringify({ type: 'registered', deviceId: 'device-1' }));
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  try {
    await withSlowFixture(`http://127.0.0.1:${String(port)}`, async (fixture) => {
      const child = startCli(fixture);

      try {
        // The code is on screen before the slow engine has answered anything: the
        // pairing screen is what this whole change is about not waiting.
        await readUntil(child, /Waiting for browser connection/);

        const register = received.find((message) => message.type === 'register');
        assert.notEqual(register, undefined);

        // Only opencode is asserted on, rather than the whole list: a machine
        // running this suite may have other engines on its real PATH, and this is
        // about the one whose listing was made to be slow.
        const registeredOpencode = register?.engines?.find((engine) => engine.name === 'opencode');
        assert.notEqual(registeredOpencode, undefined);
        assert.deepEqual(registeredOpencode?.models, []);

        // engines_updated arrives afterwards, on its own, once the slow engine's
        // own CLI has finally answered.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for engines_updated.'));
          }, 20000);

          const check = (): void => {
            const updated = received.find((message) => message.type === 'engines_updated');
            if (updated !== undefined) {
              clearTimeout(timer);
              resolve();
              return;
            }
            setTimeout(check, 20);
          };

          check();
        });

        const updated = received.find((message) => message.type === 'engines_updated');
        const updatedOpencode = updated?.engines?.find((engine) => engine.name === 'opencode');
        assert.deepEqual(updatedOpencode?.models, [{ id: 'opencode/fast', label: 'Fast' }]);
      } finally {
        child.kill('SIGKILL');
      }
    });
  } finally {
    for (const socket of sockets) {
      socket.terminate();
    }
    server.close();
  }
});
