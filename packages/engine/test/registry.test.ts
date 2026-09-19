import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverEngines } from '../dist/registry.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

/**
 * Fake opencode that only has to answer `models`, which is all discovery asks.
 *
 * Answers the verbose form, which is what the adapter asks for so it can read the
 * names opencode knows. See ADR-051.
 */
const OPENCODE = `#!/usr/bin/env node
if (process.argv[2] === 'models' && process.argv[3] === '--verbose') {
  const record = (providerID, id, name) => {
    process.stdout.write(providerID + '/' + id + '\\n');
    process.stdout.write(JSON.stringify({ id, providerID, name }, null, 2) + '\\n');
  };
  record('opencode', 'fast', 'Fast');
  record('opencode', 'slow', 'Slow');
  process.exit(0);
}
process.exit(0);
`;

/** Claude Code lists no models, so its aliases are all discovery can report. */
const CLAUDE = `#!/usr/bin/env node
process.exit(0);
`;

/** Fake agy. `agy models` reports a slug followed by its display name. */
const ANTIGRAVITY = `#!/usr/bin/env node
if (process.argv[2] === 'models') {
  process.stdout.write('gemini-3.1-pro-high Gemini 3.1 Pro (High)\\n');
  process.exit(0);
}
process.exit(0);
`;

/** Fake kiro-cli. Discovery only asks it for the model list. */
const KIRO = `#!/usr/bin/env node
if (process.argv[2] === 'chat' && process.argv.includes('--list-models')) {
  process.stdout.write(JSON.stringify({ models: [{ model_name: 'claude-sonnet-4.5', model_id: 'claude-sonnet-4.5' }], default_model: 'auto' }) + '\\n');
  process.exit(0);
}
process.exit(0);
`;

/**
 * Fake codex. Discovery asks it for a login first, then lists models over the app
 * server, which speaks JSON-RPC on stdio.
 */
/**
 * Fake copilot. Discovery opens an ACP session and reads the models from it, which
 * is the only surface that reports them: the CLI has no listing command.
 */
const COPILOT = `#!/usr/bin/env node
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Copilot', version: '1.0.78' } } });
    }
    if (msg.method === 'session/new') {
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'f0e1d2c3', models: { currentModelId: 'claude-sonnet-5', availableModels: [{ modelId: 'auto', name: 'Auto' }, { modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] } } });
    }
  }
});
`;

/**
 * Fake codex. Discovery asks it for a login first, then lists models over the app
 * server, which speaks JSON-RPC on stdio.
 */
const CODEX = `#!/usr/bin/env node
if (process.argv[2] === 'login') {
  // On stderr, which is where the real CLI writes it either way, so the login is
  // read from the exit status rather than from the wording.
  process.stderr.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { userAgent: 'fake' } });
    }
    if (msg.method === 'model/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { data: [{ id: 'gpt-5.6-terra', hidden: false }, { id: 'internal-eval', hidden: true }] } });
    }
  }
});
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
      assert.deepEqual(found[0]?.models, [
        { id: 'opencode/fast', label: 'Fast' },
        { id: 'opencode/slow', label: 'Slow' },
      ]);
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
        assert.deepEqual(claude?.models, [
          { id: 'opus', label: 'opus' },
          { id: 'sonnet', label: 'sonnet' },
          { id: 'haiku', label: 'haiku' },
        ]);
      });
    });
  });
});

test('antigravity is discovered under the name its binary does not share', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('agy', ANTIGRAVITY, async () => {
      const found = await discoverEngines();

      // The engine is configured as 'antigravity' but spawned as 'agy', so the two
      // are reported separately: a lookup on the name alone would never find it.
      assert.deepEqual(
        found.map((engine) => engine.name),
        ['antigravity'],
      );
      assert.equal(found[0]?.command, 'agy');
      assert.deepEqual(found[0]?.models, [
        { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
      ]);
    });
  });
});

test('kiro is discovered under the name its binary does not share', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('kiro-cli', KIRO, async () => {
      const found = await discoverEngines();

      // Configured as 'kiro' but spawned as 'kiro-cli', the same split as
      // antigravity: a lookup on the name alone would never find it.
      assert.deepEqual(
        found.map((engine) => engine.name),
        ['kiro'],
      );
      assert.equal(found[0]?.command, 'kiro-cli');
      assert.deepEqual(found[0]?.models, [{ id: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' }]);
    });
  });
});

test('codex is discovered, and its models come from its app server', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('codex', CODEX, async () => {
      const found = await discoverEngines();

      // Configured and spawned under the same name, unlike antigravity and kiro.
      assert.deepEqual(
        found.map((engine) => engine.name),
        ['codex'],
      );
      assert.equal(found[0]?.command, 'codex');
      // The hidden model is left out: Codex keeps it out of its own picker.
      assert.deepEqual(found[0]?.models, [{ id: 'gpt-5.6-terra', label: 'gpt-5.6-terra' }]);
    });
  });
});

test('copilot is discovered, and its models come from an ACP session', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('copilot', COPILOT, async () => {
      const found = await discoverEngines();

      assert.deepEqual(
        found.map((engine) => engine.name),
        ['copilot'],
      );
      assert.equal(found[0]?.command, 'copilot');
      // Read from the session rather than from a listing command, because the CLI
      // has none and initialize answers without models.
      assert.deepEqual(found[0]?.models, [
        { id: 'auto', label: 'Auto' },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      ]);
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

/**
 * Fake copilot that takes 7 seconds to answer `session/new`.
 *
 * A real ACP-based engine spawns a process and completes a handshake before it
 * reports anything, which measured at 5-8 seconds on an ordinary machine. This
 * mimics that cost, rather than the near-instant answer the other fakes give, so
 * a timeout regression shows up the same way it would against the real thing.
 */
const SLOW_COPILOT = `#!/usr/bin/env node
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'Copilot', version: '1.0.78' } } });
    }
    if (msg.method === 'session/new') {
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'f0e1d2c3', models: { currentModelId: 'claude-sonnet-5', availableModels: [{ modelId: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] } } });
      }, 7000);
    }
  }
});
`;

test('an engine slower than the old timeout still reports its models', async () => {
  await withEmptyPath(async () => {
    await withFakeEngine('copilot', SLOW_COPILOT, async () => {
      const found = await discoverEngines();

      // Regression: a flat 5 second budget cut this off before session/new
      // answered, and reported the engine with no models rather than the ones it
      // has. The budget has to outlast a handshake this slow. See ADR-020.
      assert.deepEqual(found[0]?.models, [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]);
    });
  });
});
