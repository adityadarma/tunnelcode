import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDefaultServerUrl, serverUrlFromEnvironment } from '../dist/server-url.js';

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

const clean = {
  TUNNELCODE_SERVER_URL: undefined,
  HOST: undefined,
  PORT: undefined,
};

test('the environment says nothing when nothing is set', () => {
  // undefined is what leaves a stored config in charge.
  withEnv(clean, () => {
    assert.equal(serverUrlFromEnvironment(), undefined);
  });
});

test('HOST alone is enough to override a stored config', () => {
  withEnv({ ...clean, HOST: '10.9.20.8' }, () => {
    assert.equal(serverUrlFromEnvironment(), 'http://10.9.20.8:3000');
  });
});

test('PORT alone is enough to override a stored config', () => {
  withEnv({ ...clean, PORT: '8080' }, () => {
    assert.equal(serverUrlFromEnvironment(), 'http://localhost:8080');
  });
});

test('an empty variable does not override a stored config', () => {
  withEnv({ TUNNELCODE_SERVER_URL: '', HOST: '', PORT: '' }, () => {
    assert.equal(serverUrlFromEnvironment(), undefined);
  });
});

test('without any input the fallback is localhost', () => {
  // Running from a checkout there is no baked value, so a locally started server
  // is the only sane guess.
  withEnv(clean, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://localhost:3000');
  });
});

test('PORT alone changes the port', () => {
  withEnv({ ...clean, PORT: '8080' }, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://localhost:8080');
  });
});

test('HOST alone changes the host', () => {
  withEnv({ ...clean, HOST: 'rc.internal' }, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://rc.internal:3000');
  });
});

test('HOST and PORT are combined', () => {
  withEnv({ ...clean, HOST: 'rc.internal', PORT: '9000' }, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://rc.internal:9000');
  });
});

test('a bind address is mapped back to localhost', () => {
  // 0.0.0.0 and :: are bind addresses, not addresses a client can connect to.
  for (const host of ['0.0.0.0', '::']) {
    withEnv({ ...clean, HOST: host, PORT: '3000' }, () => {
      assert.equal(resolveDefaultServerUrl(), 'http://localhost:3000');
    });
  }
});

test('TUNNELCODE_SERVER_URL wins over host and port', () => {
  withEnv(
    { TUNNELCODE_SERVER_URL: 'https://rc.example.com', HOST: 'ignored', PORT: '1234' },
    () => {
      // A remote deployment is not described by a local host and port at all.
      assert.equal(resolveDefaultServerUrl(), 'https://rc.example.com');
    },
  );
});

test('an empty variable is treated as unset', () => {
  withEnv({ TUNNELCODE_SERVER_URL: '', HOST: '', PORT: '' }, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://localhost:3000');
  });
});

test('an empty host with a port still resolves', () => {
  withEnv({ ...clean, HOST: '', PORT: '7000' }, () => {
    assert.equal(resolveDefaultServerUrl(), 'http://localhost:7000');
  });
});
