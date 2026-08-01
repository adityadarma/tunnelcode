import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postJson, withServer } from './server-helpers.ts';

/** Matches the limit configured on the pair route. */
const PAIR_MAX_ATTEMPTS = 10;

test('the pair endpoint stops accepting after the limit', async () => {
  await withServer(async ({ baseUrl }) => {
    const statuses: number[] = [];

    // Every code is wrong, which is exactly the case a guesser would produce.
    for (let i = 0; i < PAIR_MAX_ATTEMPTS + 3; i += 1) {
      const code = `AAAAAAA${String.fromCharCode(65 + i)}`;
      const response = await postJson(baseUrl, '/pair', { code });
      statuses.push(response.status);
    }

    const refused = statuses.filter((status) => status === 429);
    const allowed = statuses.filter((status) => status !== 429);

    // A wrong code has to count against the limit, otherwise guessing is free.
    assert.equal(allowed.length, PAIR_MAX_ATTEMPTS);
    assert.equal(refused.length, 3);
  });
});

test('a rejected request explains itself', async () => {
  await withServer(async ({ baseUrl }) => {
    let body: Record<string, unknown> = {};

    for (let i = 0; i < PAIR_MAX_ATTEMPTS + 1; i += 1) {
      const response = await postJson(baseUrl, '/pair', { code: 'ZZZZZZZZ' });
      body = response.body;
    }

    // The error handler normalises every client error to the same shape, so the
    // browser never has to deal with two different error formats.
    assert.match(String(body['error']), /Rate limit exceeded/);
  });
});

test('a malformed code still counts against the limit', async () => {
  await withServer(async ({ baseUrl }) => {
    const statuses: number[] = [];

    for (let i = 0; i < PAIR_MAX_ATTEMPTS + 2; i += 1) {
      const response = await postJson(baseUrl, '/pair', { code: 'nope' });
      statuses.push(response.status);
    }

    // Validation runs after the limit, so junk cannot be used to probe cheaply.
    assert.ok(statuses.includes(429));
  });
});

test('the limit is per server, not per code', async () => {
  await withServer(async ({ baseUrl }) => {
    for (let i = 0; i < PAIR_MAX_ATTEMPTS; i += 1) {
      await postJson(baseUrl, '/pair', { code: `BBBBBBB${String.fromCharCode(65 + i)}` });
    }

    // Switching to a fresh code must not reset the budget.
    const next = await postJson(baseUrl, '/pair', { code: 'CCCCCCCC' });
    assert.equal(next.status, 429);
  });
});

test('a forwarded address cannot reset the limit', async () => {
  await withServer(async ({ baseUrl }) => {
    const statuses: number[] = [];

    // A header the client writes, claiming to be a different machine each time.
    // Trusted unconditionally, this made the pairing limit stop counting, which is
    // the one thing standing between a short code and free guessing. See ADR-027.
    for (let i = 0; i < PAIR_MAX_ATTEMPTS + 3; i += 1) {
      const response = await postJson(
        baseUrl,
        '/pair',
        { code: 'ZZZZZZZZ' },
        { 'x-forwarded-for': `203.0.113.${String(i + 1)}` },
      );
      statuses.push(response.status);
    }

    assert.equal(statuses.filter((status) => status !== 429).length, PAIR_MAX_ATTEMPTS);
  });
});

test('a trusted proxy can still tell its clients apart', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const statuses: number[] = [];

      for (let i = 0; i < PAIR_MAX_ATTEMPTS + 3; i += 1) {
        const response = await postJson(
          baseUrl,
          '/pair',
          { code: 'ZZZZZZZZ' },
          { 'x-forwarded-for': `203.0.113.${String(i + 1)}` },
        );
        statuses.push(response.status);
      }

      // Opting in is what a real deployment behind a proxy needs: without it every
      // client shares the proxy's address and one of them exhausts the budget for
      // all of them.
      assert.equal(statuses.filter((status) => status === 429).length, 0);
    },
    { trustProxy: true },
  );
});
