import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, getJson, postJson, wait, withServer } from './server-helpers.ts';

interface CliEvent {
  type: string;
  deviceId?: string;
  requestId?: string;
  approvalNumber?: string;
  message?: string;
  fatal?: boolean;
}

const register = {
  type: 'register',
  code: 'ABCDEFGH',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'opencode', models: ['opencode/fast'] }],
};

test('health reports the database is reachable', async () => {
  await withServer(async ({ baseUrl }) => {
    const { status, body } = await getJson(baseUrl, '/api/health');

    assert.equal(status, 200);
    assert.equal(body['status'], 'ok');
  });
});

test('a correct code only creates a pending approval', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });

    assert.equal(pair.status, 202);
    assert.equal(pair.body['status'], 'pending');

    // Nothing is paired until the terminal approves.
    const status = await getJson(baseUrl, `/api/pair/${String(pair.body['requestId'])}/status`);
    assert.equal(status.body['status'], 'pending');

    cli.close();
  });
});

test('the browser and the terminal see the same approval number', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

    const request = cli.events.find((event) => event.type === 'pair_request');

    // If these ever differ, the check the user performs is meaningless.
    assert.equal(request?.approvalNumber, pair.body['approvalNumber']);

    cli.close();
  });
});

test('approving opens a session', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

    cli.send({ type: 'approve', requestId: pair.body['requestId'] });
    await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

    const status = await getJson(baseUrl, `/api/pair/${String(pair.body['requestId'])}/status`);
    assert.equal(status.body['status'], 'approved');
    assert.equal(typeof status.body['sessionId'], 'string');

    cli.close();
  });
});

test('rejecting never pairs', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

    cli.send({ type: 'reject', requestId: pair.body['requestId'] });

    const deadline = Date.now() + 3000;
    let outcome = 'pending';

    while (Date.now() < deadline && outcome === 'pending') {
      const status = await getJson(baseUrl, `/api/pair/${String(pair.body['requestId'])}/status`);
      outcome = String(status.body['status']);
    }

    assert.equal(outcome, 'rejected');
    cli.close();
  });
});

test('a code cannot be used twice', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));
    cli.send({ type: 'approve', requestId: pair.body['requestId'] });
    await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

    // The code is single use, so a second browser must not get in.
    const second = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    assert.equal(second.status, 404);

    cli.close();
  });
});

test('an unknown code is indistinguishable from a used one', async () => {
  await withServer(async ({ baseUrl }) => {
    const unknown = await postJson(baseUrl, '/api/pair', { code: 'ZZZZZZZZ' });

    // Same status and message, so the response cannot be used to find valid codes.
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body['error'], 'Pairing code is not available.');
  });
});

test('a malformed code is refused by validation', async () => {
  await withServer(async ({ baseUrl }) => {
    for (const code of ['abcdefgh', 'ABC', 'ABCDEFGHI', '']) {
      const response = await postJson(baseUrl, '/api/pair', { code });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(code)}`);
    }
  });
});

test('only the owning CLI can approve', async () => {
  await withServer(async ({ baseUrl }) => {
    const owner = await connect<CliEvent>(baseUrl, '/ws/cli');
    owner.send(register);
    await owner.waitFor((events) => events.some((event) => event.type === 'registered'));

    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, code: 'QQQQQQQQ', deviceId: 'device-2' });
    await other.waitFor((events) => events.some((event) => event.type === 'registered'));

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    await owner.waitFor((events) => events.some((event) => event.type === 'pair_request'));

    other.send({ type: 'approve', requestId: pair.body['requestId'] });
    await other.waitFor((events) => events.some((event) => event.type === 'error'));

    const status = await getJson(baseUrl, `/api/pair/${String(pair.body['requestId'])}/status`);
    assert.equal(status.body['status'], 'pending');

    owner.close();
    other.close();
  });
});

test('an unregistered connection cannot approve', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send({ type: 'approve', requestId: 'anything' });
    await cli.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(cli.events.at(-1)?.message ?? '', /Not registered/);
    cli.close();
  });
});

test('two CLIs cannot share one code', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await connect<CliEvent>(baseUrl, '/ws/cli');
    first.send(register);
    await first.waitFor((events) => events.some((event) => event.type === 'registered'));

    const second = await connect<CliEvent>(baseUrl, '/ws/cli');
    second.send({ ...register, deviceId: 'device-2' });
    await second.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(second.events.at(-1)?.message ?? '', /already in use/);

    first.close();
    second.close();
  });
});

test('a malformed frame is rejected', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.socket.send('not json');
    await cli.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(cli.events.at(-1)?.message ?? '', /Invalid message/);
    cli.close();
  });
});

test('a code is freed when its CLI disconnects', async () => {
  await withServer(async ({ baseUrl }) => {
    const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
    cli.send(register);
    await cli.waitFor((events) => events.some((event) => event.type === 'registered'));
    cli.close();

    const deadline = Date.now() + 3000;
    let status = 202;

    while (Date.now() < deadline && status === 202) {
      const response = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
      status = response.status;
    }

    // A code is only valid while its CLI session runs.
    assert.equal(status, 404);
  });
});

test('a reconnect survives the old socket closing', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await connect<CliEvent>(baseUrl, '/ws/cli');
    first.send(register);
    await first.waitFor((events) => events.some((event) => event.type === 'registered'));

    // The CLI reconnects under the same code, because the code on screen has to
    // keep working across a dropped connection.
    const second = await connect<CliEvent>(baseUrl, '/ws/cli');
    second.send(register);
    await second.waitFor((events) => events.some((event) => event.type === 'registered'));

    // The old socket closes after the replacement registered. Treating that as a
    // disconnect would free the code the reconnected CLI is still showing.
    first.close();
    await wait(200);

    const pair = await postJson(baseUrl, '/api/pair', { code: 'ABCDEFGH' });
    assert.equal(pair.status, 202);

    // The request has to reach the surviving connection, not the closed one.
    await second.waitFor((events) => events.some((event) => event.type === 'pair_request'));

    second.close();
  });
});

test('an unknown request id is not found', async () => {
  await withServer(async ({ baseUrl }) => {
    const status = await getJson(baseUrl, '/api/pair/does-not-exist/status');
    assert.equal(status.status, 404);
  });
});

test('a second agent in the same workspace is told the workspace is busy', async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await connect<CliEvent>(baseUrl, '/ws/cli');
    first.send(register);
    await first.waitFor((events) => events.some((event) => event.type === 'registered'));

    // Same machine and workspace means the same device id, but a fresh code.
    const second = await connect<CliEvent>(baseUrl, '/ws/cli');
    second.send({ ...register, code: 'ZZZZZZZZ' });
    await second.waitFor((events) => events.some((event) => event.type === 'error'));

    const error = second.events.at(-1);

    // Saying the code is in use would be wrong: this code has never been seen.
    assert.match(error?.message ?? '', /already running an agent/);
    // Marked fatal so the CLI stops instead of reconnecting in a loop.
    assert.equal(error?.fatal, true);

    first.close();
    second.close();
  });
});

test('a taken code is fatal too', async () => {
  await withServer(async ({ baseUrl }) => {
    const owner = await connect<CliEvent>(baseUrl, '/ws/cli');
    owner.send(register);
    await owner.waitFor((events) => events.some((event) => event.type === 'registered'));

    const other = await connect<CliEvent>(baseUrl, '/ws/cli');
    other.send({ ...register, deviceId: 'device-2' });
    await other.waitFor((events) => events.some((event) => event.type === 'error'));

    assert.match(other.events.at(-1)?.message ?? '', /already in use/);
    assert.equal(other.events.at(-1)?.fatal, true);

    owner.close();
    other.close();
  });
});
