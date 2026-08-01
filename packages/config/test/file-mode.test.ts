import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, stat, writeFile } from 'node:fs/promises';
import { addGrants } from '../dist/grants.js';
import { machineIdPath, readOrCreateDeviceId } from '../dist/device-id.js';
import { globalConfigPath, grantsPath } from '../dist/paths.js';
import { writeGlobalConfig } from '../dist/write.js';
import { withTempHome } from './helpers.ts';

/**
 * Windows has no POSIX mode to assert, so the check is skipped there rather than
 * asserting something the platform does not implement.
 */
const posix = process.platform !== 'win32';

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

const config = {
  server: { url: 'https://server.example.com' },
  device: { name: 'Test Mac' },
  engine: 'opencode' as const,
};

test('the config is readable only by its owner', { skip: !posix }, async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(config);

    // It names the server this machine answers to, which is not another account's
    // business. See ADR-029.
    assert.equal(await modeOf(globalConfigPath()), 0o600);
  });
});

test('granted permissions are readable only by their owner', { skip: !posix }, async () => {
  await withTempHome(async () => {
    await addGrants(['Bash(git *)']);

    // The most sensitive file this project writes: it is the list of tool calls
    // this machine will make without asking anybody first.
    assert.equal(await modeOf(grantsPath()), 0o600);
  });
});

test('the machine id is readable only by its owner', { skip: !posix }, async () => {
  await withTempHome(async () => {
    await readOrCreateDeviceId('/work/project');

    assert.equal(await modeOf(machineIdPath()), 0o600);
  });
});

test('a file left world readable is tightened on the next write', { skip: !posix }, async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(config);
    // The state an install from before this change leaves behind.
    await chmod(globalConfigPath(), 0o644);

    await writeGlobalConfig({ ...config, device: { name: 'Renamed' } });

    // A mode only applies to a file being created, so without correcting it after
    // the rename an existing file would keep the permissions it was born with.
    assert.equal(await modeOf(globalConfigPath()), 0o600);
  });
});

test('the directory holding them is owner only', { skip: !posix }, async () => {
  await withTempHome(async () => {
    await writeGlobalConfig(config);

    const directory = globalConfigPath().replace(/[/\\][^/\\]+$/, '');
    assert.equal(await modeOf(directory), 0o700);
  });
});

test('writing does not depend on the file already existing', async () => {
  await withTempHome(async () => {
    // Guards the ordering inside the atomic write: the temp file is created, then
    // renamed, then tightened. A failure anywhere in that chain would surface here
    // rather than as a mode assertion.
    await writeGlobalConfig(config);
    await writeFile(`${globalConfigPath()}.sibling`, 'x', 'utf8');
    await writeGlobalConfig(config);

    assert.ok((await stat(globalConfigPath())).isFile());
  });
});
