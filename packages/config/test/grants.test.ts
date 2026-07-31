import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addGrants, loadGrants, writeGrants } from '../dist/grants.js';
import { globalConfigPath, grantsPath } from '../dist/paths.js';
import { withTempHome } from './helpers.ts';

async function writeRaw(content: string): Promise<void> {
  const path = grantsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

test('no grants file means nothing has been granted', async () => {
  await withTempHome(async () => {
    assert.deepEqual(await loadGrants(), []);
  });
});

test('grants are kept out of the settings file', async () => {
  await withTempHome(async () => {
    // Accumulated from taps on a phone rather than typed by anyone, so mixing them
    // into the file the user reads would make that file unreasonable. See ADR-022.
    assert.notEqual(grantsPath(), globalConfigPath());
    assert.equal(dirname(grantsPath()), dirname(globalConfigPath()));
  });
});

test('a granted rule reads back', async () => {
  await withTempHome(async () => {
    const added = await addGrants(['Bash(curl *)']);

    assert.deepEqual(added, ['Bash(curl *)']);
    assert.deepEqual(
      (await loadGrants()).map((grant) => grant.rule),
      ['Bash(curl *)'],
    );
  });
});

test('granting the same rule twice changes nothing', async () => {
  await withTempHome(async () => {
    await addGrants(['Bash(curl *)']);
    const again = await addGrants(['Bash(curl *)', 'WebFetch']);

    // Only what was actually new is reported, so the CLI never claims a grant it
    // did not make.
    assert.deepEqual(again, ['WebFetch']);
    assert.equal((await loadGrants()).length, 2);
  });
});

test('an empty rule is not granted', async () => {
  await withTempHome(async () => {
    assert.deepEqual(await addGrants(['', '   ']), ['   ']);
    assert.equal((await loadGrants()).length, 1);
  });
});

test('clearing leaves nothing granted', async () => {
  await withTempHome(async () => {
    await addGrants(['Bash']);
    await writeGrants([]);

    assert.deepEqual(await loadGrants(), []);
  });
});

test('an unreadable grants file means no grants rather than a failure', async () => {
  await withTempHome(async () => {
    await writeRaw('{ not json');

    // Unlike the settings file this is not something anyone typed, so refusing to
    // start would block the CLI on a file the user never touched. Losing grants
    // only means being asked again, which is the safe direction.
    assert.deepEqual(await loadGrants(), []);
  });
});

test('a grants file of the wrong shape is ignored', async () => {
  await withTempHome(async () => {
    await writeRaw(JSON.stringify({ grants: [{ rule: 42 }] }));

    assert.deepEqual(await loadGrants(), []);
  });
});
