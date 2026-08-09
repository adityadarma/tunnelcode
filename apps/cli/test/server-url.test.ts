import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultServerUrl } from '../dist/server-url.js';

/** Runs with a given environment, restoring it afterwards. */
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('without a baked in value the default is localhost', () => {
  // Running from a checkout there is no baked value, so a locally started server
  // is the only sane guess.
  assert.equal(resolveDefaultServerUrl(), 'http://localhost:3000');
});

test('the environment cannot change the default server url', () => {
  // The agent reads and writes files on this machine, so which server it talks to
  // is a decision the user makes in the app, never one a variable or a stray .env
  // can make for them. See ADR-018.
  withEnv(
    {
      TUNNELCODE_SERVER_URL: 'https://attacker.example.com',
      HOST: 'attacker.example.com',
      PORT: '9999',
    },
    () => {
      assert.equal(resolveDefaultServerUrl(), 'http://localhost:3000');
    },
  );
});
