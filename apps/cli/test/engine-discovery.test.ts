import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverEnginesSplit } from '../dist/engine-discovery.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/** Claude Code lists no models, so its aliases are all discovery could report. */
const CLAUDE = `#!/usr/bin/env node
process.exit(0);
`;

/**
 * Fake opencode that answers `models --verbose` slowly, so a test can observe
 * `immediate` resolving before `remaining` does.
 */
const SLOW_OPENCODE = `#!/usr/bin/env node
if (process.argv[2] === 'models' && process.argv[3] === '--verbose') {
  setTimeout(() => {
    const record = (providerID, id, name) => {
      process.stdout.write(providerID + '/' + id + '\\n');
      process.stdout.write(JSON.stringify({ id, providerID, name }, null, 2) + '\\n');
    };
    record('opencode', 'fast', 'Fast');
    process.exit(0);
  }, 50);
  return;
}
process.exit(0);
`;

test('nothing installed reports an empty list and nothing to wait for', async () => {
  await withEmptyPath(async () => {
    const { immediate, remaining } = await discoverEnginesSplit();

    assert.deepEqual(immediate, []);
    assert.equal(remaining, undefined);
  });
});

test('an installed engine is offered immediately, with no models yet', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('opencode', SLOW_OPENCODE, async () => {
      const { immediate, remaining } = await discoverEnginesSplit();

      // Ready as soon as `which` resolves, before the engine's own CLI has been
      // asked anything: the pairing code is what is waiting on this.
      assert.deepEqual(
        immediate.map((engine) => ({ name: engine.name, models: engine.models })),
        [{ name: 'opencode', models: [] }],
      );
      assert.notEqual(remaining, undefined);
    });
  });
});

test('remaining resolves with the models immediate did not have yet', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('opencode', SLOW_OPENCODE, async () => {
      const { remaining } = await discoverEnginesSplit();
      const full = await remaining;

      assert.deepEqual(
        full?.map((engine) => ({ name: engine.name, models: engine.models })),
        [{ name: 'opencode', models: [{ id: 'opencode/fast', label: 'Fast' }] }],
      );
    });
  });
});

test('an engine with no listing command still resolves, not an error', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('claude', CLAUDE, async () => {
      const { remaining } = await discoverEnginesSplit();
      const full = await remaining;

      // Claude Code has no command that lists models, only the aliases its
      // --model flag accepts, which are what listModels reports here. What
      // matters for this test is that resolving costs nothing to await, not
      // which models come back. See ADR-051.
      assert.equal(full?.length, 1);
      assert.equal(full?.[0]?.name, 'claude');
    });
  });
});

test('several installed engines are all offered immediately and all resolved', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('opencode', SLOW_OPENCODE, async () => {
      await withFakeEngine('claude', CLAUDE, async () => {
        const { immediate, remaining } = await discoverEnginesSplit();

        assert.deepEqual(immediate.map((engine) => engine.name).sort(), ['claude', 'opencode']);

        const full = await remaining;
        assert.deepEqual(full?.map((engine) => engine.name).sort(), ['claude', 'opencode']);
      });
    });
  });
});
