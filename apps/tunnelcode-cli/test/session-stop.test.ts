import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

/**
 * Ctrl+C has to end the process, not just mark it as stopping.
 *
 * These spawn the real CLI because the bug only appears in a running process: the
 * session sits in an await that nothing else resolves, so the process stayed
 * alive with its socket open and kept holding the pairing code, which made the
 * next run fail with "this workspace is already running an agent".
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

/**
 * Creates an isolated home holding the fake engine.
 *
 * The server URL is written into the config, because that is now the only place
 * the CLI reads it from: no flag and no environment variable can point it
 * somewhere else. See ADR-018.
 */
async function withFixture<T>(
  serverUrl: string,
  run: (fixture: Fixture) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-stop-home-'));
  const binDir = await mkdtemp(join(tmpdir(), 'tunnelcode-stop-bin-'));

  const enginePath = join(binDir, 'opencode');
  await writeFile(enginePath, FAKE_ENGINE, 'utf8');
  await chmod(enginePath, 0o755);

  const configDir = join(home, '.config', 'tunnelcode');
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
 * Starts the CLI with an isolated home and the fake engine on PATH, then picks
 * Continue from the menu.
 *
 * Stdin is a pipe rather than ignored, since the menu has to be answered before
 * a session exists to interrupt.
 */
function startCli(fixture: Fixture): ChildProcess {
  const child = spawn(process.execPath, ['./dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Left open: closing it would end the menu's line reader, and a closed stdin
  // reads as a refusal.
  child.stdin?.write('1\n');

  return child;
}

/** Resolves once the CLI has written something matching, or rejects on timeout. */
async function waitForOutput(child: ChildProcess, pattern: RegExp): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${String(pattern)}. Saw: ${seen}`));
    }, 20000);

    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('utf8');

      if (pattern.test(seen)) {
        clearTimeout(timer);
        resolve();
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}

/** Resolves with the exit code, or undefined when the process outlives the wait. */
async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | undefined> {
  return await new Promise<number | undefined>((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

/** Starts a listening WebSocket server and reports the URL to configure. */
async function listen(server: WebSocketServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.on('listening', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return `http://127.0.0.1:${String(port)}`;
}

test('Ctrl+C ends a CLI that is waiting to pair', async () => {
  // A server that accepts the connection and registers the device, which is the
  // state the CLI sits in while showing its QR code.
  const server = new WebSocketServer({ port: 0, path: '/ws/cli' });
  const sockets: WebSocket[] = [];

  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', () => {
      socket.send(JSON.stringify({ type: 'registered', deviceId: 'device-1' }));
    });
  });

  const url = await listen(server);

  try {
    await withFixture(url, async (fixture) => {
      const child = startCli(fixture);

      try {
        await waitForOutput(child, /Waiting for a browser to pair/);

        child.kill('SIGINT');
        const code = await waitForExit(child, 15000);

        // Undefined means the process ignored the signal and kept running, which
        // is what left the pairing code held until the machine was rebooted.
        assert.notEqual(code, undefined, 'the CLI did not exit after SIGINT');
        assert.equal(code, 0);
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

test('Ctrl+C ends a CLI that is waiting to reconnect', async () => {
  // Nothing is listening on port 1, so the CLI is inside its reconnect backoff.
  await withFixture('http://127.0.0.1:1', async (fixture) => {
    const child = startCli(fixture);

    try {
      await waitForOutput(child, /Reconnecting in/);

      child.kill('SIGINT');
      const code = await waitForExit(child, 15000);

      // The backoff grows to half a minute, so a signal has to cut the wait short
      // rather than be noticed only after it elapses.
      assert.notEqual(code, undefined, 'the CLI did not exit during the reconnect delay');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('the CLI releases its connection when stopped', async () => {
  const server = new WebSocketServer({ port: 0, path: '/ws/cli' });
  const closed: Promise<void> = new Promise((resolve) => {
    server.on('connection', (socket) => {
      socket.on('message', () => {
        socket.send(JSON.stringify({ type: 'registered', deviceId: 'device-1' }));
      });
      socket.on('close', () => {
        resolve();
      });
    });
  });

  const url = await listen(server);

  try {
    await withFixture(url, async (fixture) => {
      const child = startCli(fixture);

      try {
        await waitForOutput(child, /Waiting for a browser to pair/);
        child.kill('SIGINT');

        // The server frees a pairing code when the socket closes, so a CLI that
        // exits without closing would leave its code unusable.
        await closed;
      } finally {
        child.kill('SIGKILL');
      }
    });
  } finally {
    server.close();
  }
});
