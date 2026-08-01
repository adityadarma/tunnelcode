import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTempHome } from './helpers.ts';

/**
 * The menu is the only way to configure the CLI, so these drive the real process
 * and answer its prompts.
 *
 * Stdin is a pipe rather than a TTY, which is the path the prompts take when they
 * cannot read keypresses: the list is numbered and read as a line.
 */

interface Result {
  code: number;
  output: string;
}

/** Runs the CLI with an isolated home, answering the menu with given lines. */
async function runMenu(home: string, answers: readonly string[]): Promise<Result> {
  return runMenuIn(process.cwd(), home, answers);
}

/**
 * Runs the CLI from a given working directory.
 *
 * The directory matters because it is what the agent works in, and because a
 * project config left there by an earlier version must not be read.
 */
async function runMenuIn(cwd: string, home: string, answers: readonly string[]): Promise<Result> {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'index.js')], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  child.stdin?.end(`${answers.join('\n')}\n`);

  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });

  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(-1);
    }, 20000);

    child.on('exit', (value) => {
      clearTimeout(timer);
      resolve(value ?? 0);
    });
  });

  return { code, output };
}

/** Reads the stored global config, or undefined when nothing was written. */
async function readStoredConfig(home: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(join(home, '.config', 'tunnelcode', 'tunnelcode.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const CONTINUE = '1';
const SETUP = '2';
const EXIT = '3';
const SERVER_URL = '1';
const DEVICE_NAME = '2';
const ENGINE = '3';
const NEVER_ALLOW = '4';
const GRANTS = '5';
const BACK = '7';

test('the menu offers continue, setup, and exit', async () => {
  await withTempHome(async (home) => {
    const { code, output } = await runMenu(home, [EXIT]);

    assert.equal(code, 0);
    assert.match(output, /Scan QR/);
    assert.match(output, /Setup/);
    assert.match(output, /Exit/);
  });
});

test('exit leaves without writing a config', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [EXIT]);

    // Opening the menu is not a decision, so nothing should be stored yet.
    assert.equal(await readStoredConfig(home), undefined);
  });
});

test('setup writes the server url chosen in the menu', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, SERVER_URL, 'http://127.0.0.1:4321', BACK, EXIT]);

    const stored = await readStoredConfig(home);
    assert.deepEqual(stored?.['server'], { url: 'http://127.0.0.1:4321' });
  });
});

test('a first change writes a complete config, not only the field touched', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, DEVICE_NAME, 'Test Mac', BACK, EXIT]);

    const stored = await readStoredConfig(home);

    // A config missing the server or the engine would fail validation on the next
    // run, so the untouched fields have to be written with their defaults.
    assert.deepEqual(stored?.['device'], { name: 'Test Mac' });
    assert.equal(typeof stored?.['engine'], 'string');
    assert.ok(stored?.['server'] !== undefined);
  });
});

test('a server url without a scheme is refused', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenu(home, [SETUP, SERVER_URL, 'localhost:3000', BACK, EXIT]);

    // Stored as-is this fails much later, when the socket cannot be opened, with
    // a message that says nothing about the typo.
    assert.match(output, /http:\/\/ or https:\/\//);
    assert.equal(await readStoredConfig(home), undefined);
  });
});

test('the menu shows the stored server url as the current value', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, SERVER_URL, 'http://127.0.0.1:4321', BACK, EXIT]);
    const { output } = await runMenu(home, [SETUP, BACK, EXIT]);

    assert.match(output, /http:\/\/127\.0\.0\.1:4321/);
  });
});

test('continue without a configured engine reports why it stopped', async () => {
  await withTempHome(async (home) => {
    // No config has been written, so there is nothing to start.
    const { code, output } = await runMenu(home, [CONTINUE]);

    assert.equal(code, 1);
    assert.match(output, /Setup/);
  });
});

test('setup offers one engine setting, not a default plus a project override', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenu(home, [SETUP, BACK, EXIT]);

    assert.match(output, /Engine/);
    assert.doesNotMatch(output, /Default engine/);
    assert.doesNotMatch(output, /this project/);
  });
});

test('a config file in the working directory is ignored', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, ENGINE, '1', BACK, EXIT]);

    const workspace = await mkdtemp(join(tmpdir(), 'tunnelcode-ws-'));
    await mkdir(join(workspace, '.tunnelcode'), { recursive: true });
    await writeFile(
      join(workspace, '.tunnelcode', 'config.json'),
      JSON.stringify({ engine: 'claude' }),
      'utf8',
    );

    try {
      // Configuration is per user now, so a file left in a project directory by an
      // earlier version must not quietly change which engine runs. See ADR-019.
      const { output } = await runMenuIn(workspace, home, [SETUP, BACK, EXIT]);

      assert.match(output, /opencode/);
      assert.doesNotMatch(output, /claude/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test('the environment cannot point the agent at another server', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, SERVER_URL, 'http://127.0.0.1:4321', BACK, EXIT]);

    const child = spawn(process.execPath, ['./dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        TUNNELCODE_SERVER_URL: 'https://attacker.example.com',
        HOST: 'attacker.example.com',
        PORT: '9999',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.end(`${[SETUP, BACK, EXIT].join('\n')}\n`);

    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });

    await new Promise<void>((resolve) => {
      child.on('exit', () => {
        resolve();
      });
    });

    // The agent reads and writes files on this machine, so a variable must not be
    // able to redirect it. See ADR-018.
    assert.match(output, /http:\/\/127\.0\.0\.1:4321/);
    assert.doesNotMatch(output, /attacker\.example\.com/);
  });
});

test('setup stores the ceiling on what may ever be allowed', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, NEVER_ALLOW, 'Bash(rm *), WebFetch', BACK, EXIT]);

    const stored = await readStoredConfig(home);

    // Answered in a terminal on the machine rather than in the browser, because a
    // paired session lives in a phone that gets lost and left unlocked.
    // See ADR-022.
    assert.deepEqual(stored?.['permission'], { deny: ['Bash(rm *)', 'WebFetch'] });
  });
});

test('a ceiling can be taken back off', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, NEVER_ALLOW, 'Bash', BACK, EXIT]);
    await runMenu(home, [SETUP, NEVER_ALLOW, '-', BACK, EXIT]);

    // An empty answer keeps the current value everywhere in this menu, so without
    // an explicit clear there would be no way back to refusing nothing.
    assert.deepEqual(stripDeny(await readStoredConfig(home)), []);
  });
});

test('granted permissions can be listed and cleared', async () => {
  await withTempHome(async (home) => {
    const grants = join(home, '.config', 'tunnelcode', 'permissions.json');
    await mkdir(join(home, '.config', 'tunnelcode'), { recursive: true });
    await writeFile(
      grants,
      JSON.stringify({ grants: [{ rule: 'Bash(curl *)', grantedAt: 1 }] }),
      'utf8',
    );

    const { output } = await runMenu(home, [SETUP, GRANTS, '2', BACK, EXIT]);

    // A lasting grant with no way to see or withdraw it would be the worst part of
    // the feature rather than the convenient one. See ADR-022.
    assert.match(output, /Bash\(curl \*\)/);

    const remaining = JSON.parse(await readFile(grants, 'utf8')) as { grants: unknown[] };
    assert.deepEqual(remaining.grants, []);
  });
});

function stripDeny(stored: Record<string, unknown> | undefined): unknown {
  const permission = stored?.['permission'];
  return typeof permission === 'object' && permission !== null
    ? (permission as { deny?: unknown }).deny
    : undefined;
}
