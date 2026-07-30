import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverEngines } from '../dist/registry.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/** Fake opencode that only has to answer `models`, which is all discovery asks. */
const OPENCODE = `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('opencode/fast\\nopencode/slow\\n');
  process.exit(0);
}
process.exit(0);
`;

/** Claude Code lists no models, so its aliases are all discovery can report. */
const CLAUDE = `#!/usr/bin/env node
process.exit(0);
`;

test('an engine that is not installed is never offered', async () => {
  await withEmptyPath(async () => {
    // Supported but absent is the same as unusable: a browser offered it would
    // have every prompt fail. See ADR-020.
    assert.deepEqual(await discoverEngines(), []);
  });
});

test('only the installed engines are reported, with their own models', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('opencode', OPENCODE, async () => {
      const found = await discoverEngines();

      assert.deepEqual(
        found.map((engine) => engine.name),
        ['opencode'],
      );
      assert.deepEqual(found[0]?.models, ['opencode/fast', 'opencode/slow']);
    });
  });
});

test('several installed engines are all reported', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('opencode', OPENCODE, async () => {
      await withFakeEngine('claude', CLAUDE, async () => {
        const found = await discoverEngines();

        // The intersection of supported and installed, which is what the browser
        // may choose between.
        assert.deepEqual(found.map((engine) => engine.name).sort(), ['claude', 'opencode']);

        // Models stay with their engine, so one engine's model is never offered
        // for another.
        const claude = found.find((engine) => engine.name === 'claude');
        assert.deepEqual(claude?.models, ['opus', 'sonnet', 'haiku']);
      });
    });
  });
});

test('an engine that cannot list models is still offered', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('claude', CLAUDE, async () => {
      const found = await discoverEngines();

      // An empty model list means "use the engine default", not "unusable".
      assert.equal(found.length, 1);
      assert.equal(found[0]?.command, 'claude');
    });
  });
});
