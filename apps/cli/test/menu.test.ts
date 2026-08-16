import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { homeEnv, withTempHome } from './helpers.ts';

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
 *
 * Extra environment is merged last, so a test can take PATH away and get a run
 * that stops on a missing engine rather than one that opens a pairing session and
 * waits for a browser.
 */
async function runMenuIn(
  cwd: string,
  home: string,
  answers: readonly string[],
  env: Record<string, string> = {},
): Promise<Result> {
  const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'index.js')], {
    cwd,
    env: {
      ...process.env,
      ...homeEnv(home),
      ...env,
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

/**
 * Where the stored config lands under an isolated home.
 *
 * Windows keeps it under APPDATA rather than in a dotted directory, so a single
 * hardcoded path would look for a file the CLI never wrote. See ADR-011.
 */
function storedConfigPath(home: string): string {
  return process.platform === 'win32'
    ? join(home, 'AppData', 'Roaming', 'TunnelCode', 'tunnelcode.json')
    : join(home, '.config', 'tunnelcode', 'tunnelcode.json');
}

/** Reads the stored global config, or undefined when nothing was written. */
async function readStoredConfig(home: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await readFile(storedConfigPath(home), 'utf8');
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
const TIMEOUTS = '4';
const NEVER_ALLOW = '5';
const GRANTS = '6';
const ANTIGRAVITY_ACCESS = '7';
const BACK = '9';

/** Answers inside the Antigravity submenu, where each item toggles one grant. */
const ALLOW_WRITES = '1';
const ALLOW_COMMANDS = '2';
const ANTIGRAVITY_BACK = '3';

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

    // A config missing the server would fail validation on the next run, so the
    // untouched fields have to be written with their defaults.
    assert.deepEqual(stored?.['device'], { name: 'Test Mac' });
    assert.ok(stored?.['server'] !== undefined);

    // The engine is the exception: nothing was chosen, and which engines exist here
    // is not something the machine was asked. See ADR-056.
    assert.equal(stored?.['engine'], undefined);
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

/**
 * An environment with nothing on PATH, so engine discovery finds none.
 *
 * A run that gets as far as pairing waits for a browser until the test kills it,
 * so tests about what happens before that need a reason for it to stop.
 */
const NO_ENGINES = { PATH: '', Path: '' };

/**
 * An environment where exactly one engine is installed, whatever this machine has.
 *
 * Setup now reports which engines are here, and a developer's own machine has some
 * of them, so a test that read the real PATH would assert on the wrong list.
 */
async function withOnlyEngine<T>(
  name: string,
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const binDir = await mkdtemp(join(tmpdir(), 'tunnelcode-menu-bin-'));

  // A shebang means nothing on Windows and Node will not run a script by name, so
  // the fake is a .cmd shim, which is how npm installs a CLI there.
  if (process.platform === 'win32') {
    await writeFile(join(binDir, `${name}.js`), 'process.exit(0)\n', 'utf8');
    await writeFile(join(binDir, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`, 'utf8');
  } else {
    const enginePath = join(binDir, name);
    await writeFile(enginePath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(enginePath, 0o755);
  }

  // Engine lookup shells out to `which`, so that has to stay reachable: a PATH of
  // the fake directory alone finds nothing at all, including the lookup tool, and
  // every engine would report missing for the wrong reason.
  //
  // The system directories are the only ones kept. Engines install to /usr/local/bin
  // or under the home directory, so what this leaves out is exactly the real ones.
  const systemPath =
    process.platform === 'win32'
      ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
      : ['/usr/bin', '/bin'].join(delimiter);
  const path = [binDir, systemPath].join(delimiter);

  try {
    return await run({ PATH: path, Path: path });
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
}

test('the first run writes a default config instead of asking for one', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    const stored = await readStoredConfig(home);

    // Every answer setup would have asked for on a first run is one this machine
    // can make for itself, so scanning the QR works on a fresh install rather than
    // stopping to say nothing is configured. See ADR-056.
    assert.ok(stored !== undefined);
    assert.ok(stored?.['server'] !== undefined);
    assert.ok(stored?.['device'] !== undefined);
    assert.doesNotMatch(output, /No configuration yet/);
  });
});

test('the default config names no engine', async () => {
  await withTempHome(async (home) => {
    await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    const stored = await readStoredConfig(home);

    // Nothing on this machine was asked which engines it has, so naming one would be
    // a preference nobody expressed, wrong on every machine that installed something
    // else. The first installed engine leads until somebody chooses. See ADR-056.
    assert.equal(stored?.['engine'], undefined);
  });
});

test('setup reports the engine as the first installed until one is chosen', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenu(home, [SETUP, BACK, EXIT]);

    // Showing a name here would read as a setting that had been made.
    assert.match(output, /first installed/);
  });
});

test('an engine chosen in setup is stored and shown as current', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, ENGINE, '2', BACK, EXIT]);

    const stored = await readStoredConfig(home);
    assert.equal(stored?.['engine'], 'claude');

    const { output } = await runMenu(home, [SETUP, BACK, EXIT]);
    assert.match(output, /claude/);
    assert.doesNotMatch(output, /first installed/);
  });
});

test('the engine list says which engines are not installed', async () => {
  await withTempHome(async (home) => {
    await withOnlyEngine('opencode', async (env) => {
      const { output } = await runMenuIn(process.cwd(), home, [SETUP, ENGINE, BACK, EXIT], env);

      // Every supported engine is still offered, because one can be chosen before it
      // is installed. What is new is not having to scan a QR code to find out which
      // ones are here. See ADR-057.
      assert.match(output, /claude.*not installed/);
      assert.match(output, /cursor.*not installed/);

      // The one that is here says nothing, so the marks read as exceptions.
      assert.doesNotMatch(output, /opencode.*not installed/);
    });
  });
});

test('setup says so when no supported engine is installed at all', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenuIn(
      process.cwd(),
      home,
      [SETUP, ENGINE, BACK, EXIT],
      NO_ENGINES,
    );

    // A machine with nothing installed cannot run a session whatever is chosen here,
    // and finding that out from the engine list beats finding it out from a QR code.
    assert.match(output, /None of these is installed/);
  });
});

test('choosing an engine that is not installed is stored and reported', async () => {
  await withTempHome(async (home) => {
    await withOnlyEngine('opencode', async (env) => {
      const { output } = await runMenuIn(
        process.cwd(),
        home,
        [SETUP, ENGINE, '2', BACK, EXIT],
        env,
      );

      // Stored, because it is a preference: a machine that installs claude later
      // should find it already chosen rather than having to answer again.
      assert.equal((await readStoredConfig(home))?.['engine'], 'claude');

      // Said, because storing it silently would read as having taken effect.
      assert.match(output, /claude is not installed/);
    });
  });
});

test('choosing an installed engine reports nothing extra', async () => {
  await withTempHome(async (home) => {
    await withOnlyEngine('opencode', async (env) => {
      const { output } = await runMenuIn(
        process.cwd(),
        home,
        [SETUP, ENGINE, '1', BACK, EXIT],
        env,
      );

      assert.equal((await readStoredConfig(home))?.['engine'], 'opencode');
      assert.doesNotMatch(output, /is not installed, so new conversations/);
    });
  });
});

test('the first run says where the config it wrote lives', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    // Written on the user's behalf, so it is not a file they find out about later.
    assert.match(output, /First run/);
    assert.match(output, /tunnelcode\.json/);
  });
});

test('a second run does not report writing a config again', async () => {
  await withTempHome(async (home) => {
    await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);
    const { output } = await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    assert.doesNotMatch(output, /First run/);
  });
});

test('the default config never overwrites a stored answer', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, SERVER_URL, 'http://127.0.0.1:4321', BACK, EXIT]);
    await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    const stored = await readStoredConfig(home);

    // Filling in a missing file is help; replacing one the user answered is a
    // setting silently undone.
    assert.deepEqual(stored?.['server'], { url: 'http://127.0.0.1:4321' });
  });
});

test('continue without an installed engine reports why it stopped', async () => {
  await withTempHome(async (home) => {
    const { code, output } = await runMenuIn(process.cwd(), home, [CONTINUE], NO_ENGINES);

    // The config is no longer what can be missing here, but an engine still is,
    // and that one cannot be defaulted: it has to be installed.
    assert.equal(code, 1);
    assert.match(output, /Cannot find any engine on PATH/);
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
        ...homeEnv(home),
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

test('antigravity write access is granted from setup and withdrawn from the same place', async () => {
  await withTempHome(async (home) => {
    const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const allowList = async (): Promise<string[]> => {
      const parsed = JSON.parse(await readFile(settings, 'utf8')) as {
        permissions?: { allow?: string[] };
      };
      return parsed.permissions?.allow ?? [];
    };

    // Antigravity cannot be asked about a write, so this rule is the only thing that
    // lets it change anything. It is granted here rather than when a session starts,
    // because the file belongs to agy and outlives this process. See ADR-031.
    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_WRITES, BACK, EXIT]);

    const granted = await allowList();
    assert.equal(granted.length, 1);
    assert.match(granted[0] ?? '', /^write_file\(.+\)$/);

    // The first choice becomes the opposite one once it is granted, so the same
    // answer takes it back.
    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_WRITES, BACK, EXIT]);

    assert.deepEqual(await allowList(), []);
  });
});

test('running commands is granted from setup and withdrawn from the same place', async () => {
  await withTempHome(async (home) => {
    const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const allowList = async (): Promise<string[]> => {
      const parsed = JSON.parse(await readFile(settings, 'utf8')) as {
        permissions?: { allow?: string[] };
      };
      return parsed.permissions?.allow ?? [];
    };

    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_COMMANDS, BACK, EXIT]);

    // Every command rather than one program: Antigravity matches a command rule as a
    // prefix of the whole command line, and the agent puts its own cd in front of the
    // program it means to run, so a narrower rule refuses most of the work.
    assert.deepEqual(await allowList(), ['command(*)']);

    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_COMMANDS, BACK, EXIT]);

    assert.deepEqual(await allowList(), []);
  });
});

test('the two antigravity grants are separate', async () => {
  await withTempHome(async (home) => {
    const settings = join(home, '.gemini', 'antigravity-cli', 'settings.json');

    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_COMMANDS, BACK, EXIT]);
    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ALLOW_WRITES, BACK, EXIT]);

    const parsed = JSON.parse(await readFile(settings, 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    const granted = parsed.permissions?.allow ?? [];

    // Running commands is wider than the work in front of it, so it is never implied
    // by asking for write access, and withdrawing one leaves the other alone.
    assert.equal(granted.length, 2);
    assert.ok(granted.includes('command(*)'));
    assert.ok(granted.some((rule) => rule.startsWith('write_file(')));
  });
});

test('setup never writes antigravity settings unless asked', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, ANTIGRAVITY_ACCESS, ANTIGRAVITY_BACK, BACK, EXIT]);

    // Opening the item and leaving is not a decision, and the file is another
    // tool's, so nothing should have been created.
    await assert.rejects(() =>
      readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
    );
  });
});

test('granted permissions can be listed and cleared', async () => {
  await withTempHome(async (home) => {
    const configDir = dirname(storedConfigPath(home));
    const grants = join(configDir, 'permissions.json');
    await mkdir(configDir, { recursive: true });
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

/** Answers inside the Timeouts submenu. */
const TIMEOUT_IDLE = '1';
const TIMEOUT_ANSWER = '2';
const TIMEOUT_SILENCE = '3';
const TIMEOUT_DEFAULTS = '4';
const TIMEOUT_BACK = '5';

test('the setup menu shows all three timeouts', async () => {
  await withTempHome(async (home) => {
    const { output } = await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_BACK, BACK, EXIT]);

    assert.match(output, /idle/i);
    assert.match(output, /answer/i);
    assert.match(output, /silence/i);
  });
});

test('the idle timeout is changed from the timeouts submenu', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_IDLE, '30', BACK, EXIT]);

    const stored = await readStoredConfig(home);
    const timeouts = stored?.['timeouts'] as { idleMinutes?: number } | undefined;
    assert.equal(timeouts?.idleMinutes, 30);
  });
});

test('the answer timeout is changed from the timeouts submenu', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_ANSWER, '10', BACK, EXIT]);

    const stored = await readStoredConfig(home);
    const timeouts = stored?.['timeouts'] as { answerMinutes?: number } | undefined;
    assert.equal(timeouts?.answerMinutes, 10);
  });
});

test('the silence timeout is changed from the timeouts submenu', async () => {
  await withTempHome(async (home) => {
    await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_SILENCE, '25', BACK, EXIT]);

    const stored = await readStoredConfig(home);
    const timeouts = stored?.['timeouts'] as { silenceMinutes?: number } | undefined;
    assert.equal(timeouts?.silenceMinutes, 25);
  });
});

test('timeouts can be reset to defaults', async () => {
  await withTempHome(async (home) => {
    // Set a custom value first.
    await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_SILENCE, '45', BACK, EXIT]);

    const before = await readStoredConfig(home);
    const beforeTimeouts = before?.['timeouts'] as { silenceMinutes?: number } | undefined;
    assert.equal(beforeTimeouts?.silenceMinutes, 45);

    // Reset to defaults.
    await runMenu(home, [SETUP, TIMEOUTS, TIMEOUT_DEFAULTS, BACK, EXIT]);

    const after = await readStoredConfig(home);
    const afterTimeouts = after?.['timeouts'] as
      | {
          idleMinutes?: number;
          answerMinutes?: number;
          silenceMinutes?: number;
        }
      | undefined;
    assert.equal(afterTimeouts?.idleMinutes, 60);
    assert.equal(afterTimeouts?.answerMinutes, 5);
    assert.equal(afterTimeouts?.silenceMinutes, 15);
  });
});
