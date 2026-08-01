import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AntigravitySettingsError,
  allowWorkspaceWrites,
  antigravitySettingsPath,
  isWorkspaceWritable,
  revokeWorkspaceWrites,
  workspaceWriteRule,
} from '../dist/adapters/antigravity-settings.js';

/**
 * Windows has no POSIX mode to assert, so those checks are skipped there rather than
 * asserting something the platform does not implement.
 */
const posix = process.platform !== 'win32';

/**
 * The settings file belongs to `agy`, so every test runs against an isolated HOME.
 * Touching the real one would change how the user's own terminal behaves.
 */
async function withTempHome<T>(run: (home: string, workspace: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-agy-home-'));
  const workspace = await mkdtemp(join(tmpdir(), 'tunnelcode-agy-ws-'));

  // Both, because the home directory is read from HOME on Linux and macOS but from
  // USERPROFILE on Windows. Setting only one would leave the other platform writing
  // into the developer's real Antigravity settings.
  const restore = (['HOME', 'USERPROFILE'] as const).map((name) => {
    const previous = process.env[name];
    process.env[name] = home;

    return (): void => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    };
  });

  try {
    return await run(home, workspace);
  } finally {
    for (const undo of restore) {
      undo();
    }
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeSettings(home: string, value: unknown): Promise<string> {
  const path = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

test('the rule names the workspace and only asks to write', async () => {
  await withTempHome(async (_home, workspace) => {
    const rule = await workspaceWriteRule(workspace);

    // write_file implicitly grants read_file on the same target, and reading inside
    // a workspace needs no rule at all, so this is the narrowest grant that works.
    assert.match(rule, /^write_file\(.+\)$/);
    assert.doesNotMatch(rule, /command|read_url|unsandboxed|\*/);
  });
});

test('the rule resolves symlinks, because that is what Antigravity judges', async () => {
  await withTempHome(async (_home, workspace) => {
    const rule = await workspaceWriteRule(workspace);

    // A workspace reached through /tmp on macOS is refused as /private/tmp/..., so
    // a rule naming the link would never match the path being written.
    const resolved = rule.slice('write_file('.length, -1);
    assert.equal(resolved, await realpath(workspace));
  });
});

test('granting adds the rule and reports the workspace as writable', async () => {
  await withTempHome(async (home, workspace) => {
    assert.equal(await isWorkspaceWritable(workspace), false);
    assert.equal(await allowWorkspaceWrites(workspace), true);
    assert.equal(await isWorkspaceWritable(workspace), true);

    const settings = await readSettings(home);
    const permissions = settings['permissions'] as { allow: string[] };
    assert.deepEqual(permissions.allow, [await workspaceWriteRule(workspace)]);
  });
});

test('granting twice changes nothing and says so', async () => {
  await withTempHome(async (home, workspace) => {
    await allowWorkspaceWrites(workspace);
    assert.equal(await allowWorkspaceWrites(workspace), false);

    const permissions = (await readSettings(home))['permissions'] as { allow: string[] };
    assert.equal(permissions.allow.length, 1);
  });
});

test('every other setting is left exactly as it was', async () => {
  await withTempHome(async (home, workspace) => {
    await writeSettings(home, {
      trustedWorkspaces: ['/some/where'],
      somethingUnknown: { kept: true },
      permissions: {
        deny: ['command(sudo)'],
        ask: ['command(*)'],
        allow: ['command(git)'],
      },
    });

    await allowWorkspaceWrites(workspace);
    const settings = await readSettings(home);

    // This file is another tool's. A field this project does not understand is a
    // field it has no business dropping, and deny is what the user already refused.
    assert.deepEqual(settings['trustedWorkspaces'], ['/some/where']);
    assert.deepEqual(settings['somethingUnknown'], { kept: true });

    const permissions = settings['permissions'] as Record<string, unknown>;
    assert.deepEqual(permissions['deny'], ['command(sudo)']);
    assert.deepEqual(permissions['ask'], ['command(*)']);
    assert.deepEqual(permissions['allow'], ['command(git)', await workspaceWriteRule(workspace)]);
  });
});

test('withdrawing removes only the rule this project added', async () => {
  await withTempHome(async (home, workspace) => {
    await writeSettings(home, { permissions: { allow: ['command(git)'] } });

    await allowWorkspaceWrites(workspace);
    assert.equal(await revokeWorkspaceWrites(workspace), true);
    assert.equal(await isWorkspaceWritable(workspace), false);

    const permissions = (await readSettings(home))['permissions'] as { allow: string[] };
    assert.deepEqual(permissions.allow, ['command(git)']);
  });
});

test('withdrawing what was never granted changes nothing', async () => {
  await withTempHome(async (_home, workspace) => {
    assert.equal(await revokeWorkspaceWrites(workspace), false);
  });
});

test('a settings file that is not JSON is refused rather than overwritten', async () => {
  await withTempHome(async (home, workspace) => {
    const path = await writeSettings(home, {});
    await writeFile(path, '{ this is not json', 'utf8');

    // Overwriting a file this project does not own, whose contents it cannot read,
    // would destroy settings nobody asked it to touch.
    await assert.rejects(
      () => allowWorkspaceWrites(workspace),
      (error: unknown) => error instanceof AntigravitySettingsError,
    );

    assert.equal(await readFile(path, 'utf8'), '{ this is not json');

    // The menu still has to be drawable, so reading reports not granted instead.
    assert.equal(await isWorkspaceWritable(workspace), false);
  });
});

test('the mode of an existing settings file is kept', { skip: !posix }, async () => {
  await withTempHome(async (home, workspace) => {
    const path = await writeSettings(home, { trustedWorkspaces: [] });
    await chmod(path, 0o644);

    await allowWorkspaceWrites(workspace);

    // Tightening or loosening another tool's file is not this project's decision.
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  });
});

test(
  'a settings file created from nothing is readable only by its owner',
  { skip: !posix },
  async () => {
    await withTempHome(async (home, workspace) => {
      await allowWorkspaceWrites(workspace);

      // It records what an agent may do on this machine, which is not something to
      // leave for every account on a shared box to read.
      assert.equal((await stat(antigravitySettingsPath())).mode & 0o777, 0o600);
      assert.ok(antigravitySettingsPath().startsWith(home));
    });
  },
);
