import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { globalConfigPath } from '@tunnelcode/config';
import { ceilingRefusing } from '../dist/pairing/antigravity-ceiling.js';
import { withTempHome } from './helpers.ts';

/**
 * Antigravity raises no permission ask, so the policy that checks `Never allow`
 * before every grant never runs for it. Its rules are written straight into `agy`'s
 * own settings and read by `agy` before a turn starts. That is why the ceiling is
 * applied where the grant is made, and why it is worth testing there.
 */

/** Writes a config whose only content is the ceiling. */
async function withCeiling<T>(deny: readonly string[], run: () => Promise<T>): Promise<T> {
  return withTempHome(async () => {
    const path = globalConfigPath();
    await mkdir(dirname(path), { recursive: true });
    // Written in full because the config is validated as a whole, and a file that
    // fails to load would make every one of these pass for the wrong reason.
    await writeFile(
      path,
      JSON.stringify({
        server: { url: 'https://example.com' },
        device: { name: 'test' },
        engine: 'antigravity',
        permission: { deny },
      }),
      'utf8',
    );

    return run();
  });
}

test('a grant no rule forbids is left alone', async () => {
  await withCeiling(['bash(rm *)'], async () => {
    assert.equal(await ceilingRefusing('write_file(/work/project)'), undefined);
  });
});

test('nothing is forbidden when no ceiling is set', async () => {
  await withCeiling([], async () => {
    assert.equal(await ceilingRefusing('write_file(/work/project)'), undefined);
    assert.equal(await ceilingRefusing('command(*)'), undefined);
  });
});

test('a ceiling reaching the grant refuses it, and says which rule did', async () => {
  await withCeiling(['write_file(*)'], async () => {
    const refusal = await ceilingRefusing('write_file(/work/project)');

    assert.equal(refusal?.rule, 'write_file(/work/project)');
    assert.equal(refusal?.denied, 'write_file(*)');
  });
});

test('a ceiling naming the tool alone refuses every grant for it', async () => {
  await withCeiling(['write_file'], async () => {
    assert.notEqual(await ceilingRefusing('write_file(/work/project)'), undefined);
  });
});

// The grant is a rule, not a call, and `command(*)` is the wider of the two. Matching
// only one direction would let the broadest grant in the project past a ceiling
// written to stop something narrower, which is the case ADR-035 warns about.
test('a grant wider than the ceiling is still refused', async () => {
  await withCeiling(['command(rm *)'], async () => {
    const refusal = await ceilingRefusing('command(*)');

    assert.equal(refusal?.rule, 'command(*)');
    assert.equal(refusal?.denied, 'command(rm *)');
  });
});

test('a ceiling for another tool does not reach commands', async () => {
  await withCeiling(['write_file(*)'], async () => {
    assert.equal(await ceilingRefusing('command(*)'), undefined);
  });
});
