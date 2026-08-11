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
  return await new Promise<string>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${String(pattern)}. Saw: ${seen}`));
    }, 20000);

    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('utf8');

      if (pattern.test(seen)) {
        clearTimeout(timer);
        resolve(seen);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
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
        const output = await readUntil(child, /Waiting for the paired browser to reconnect/);

        // The browser holds the session already. A code, a link and a QR are three
        // ways to do something it has no need to do. See ADR-053.
        assert.doesNotMatch(output, /Pairing Code Generated/);
        assert.doesNotMatch(output, /\/login\?code=/);
        assert.doesNotMatch(output, /[\u2580-\u259f]/u);
        assert.match(output, /Nothing to scan/);
      } finally {
        child.kill('SIGKILL');
      }
    });
  });
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
