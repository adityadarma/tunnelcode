import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleTimer } from '../dist/pairing/idle.js';

/**
 * These tests drive the clock instead of waiting on it.
 *
 * Real timeouts made the suite flaky: with a timeout small enough to keep the
 * tests fast, a machine under load could take longer between two resets than the
 * timeout itself, so the timer expired and the assertion failed for a reason that
 * had nothing to do with the timer's behaviour. Ticking a mocked clock asserts the
 * same rules without depending on how busy the machine is.
 *
 * The test context owns the mock, so the real timers come back after each test
 * even if it fails partway through.
 */

test('timer fires once the timeout passes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fired = 0;
  const timer = new IdleTimer({
    onExpired: () => {
      fired += 1;
    },
    timeoutMs: 1000,
  });

  timer.start();

  t.mock.timers.tick(999);
  assert.equal(fired, 0);

  t.mock.timers.tick(1);
  assert.equal(fired, 1);

  timer.stop();
});

test('activity before the timeout postpones it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fired = 0;
  const timer = new IdleTimer({
    onExpired: () => {
      fired += 1;
    },
    timeoutMs: 1000,
  });

  timer.start();
  t.mock.timers.tick(600);
  timer.reset();
  t.mock.timers.tick(600);

  // Without the reset this would already have fired.
  assert.equal(fired, 0);

  // The wait restarts from the reset, not from start.
  t.mock.timers.tick(400);
  assert.equal(fired, 1);

  timer.stop();
});

test('stop prevents the timer from firing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fired = 0;
  const timer = new IdleTimer({
    onExpired: () => {
      fired += 1;
    },
    timeoutMs: 1000,
  });

  timer.start();
  timer.stop();
  t.mock.timers.tick(5000);

  assert.equal(fired, 0);
});

test('repeated activity never lets the timer fire', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fired = 0;
  const timer = new IdleTimer({
    onExpired: () => {
      fired += 1;
    },
    timeoutMs: 1000,
  });

  timer.start();

  // Stands in for a conversation that keeps going: every gap stays under the
  // timeout, so the session must never end however long it runs.
  for (let i = 0; i < 20; i += 1) {
    t.mock.timers.tick(900);
    timer.reset();
  }

  assert.equal(fired, 0);

  // Still armed, so silence after the last message does end it.
  t.mock.timers.tick(1000);
  assert.equal(fired, 1);

  timer.stop();
});

test('a busy session still ends at its ceiling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const expiries: string[] = [];
  const timer = new IdleTimer({
    onExpired: (expiry) => {
      expiries.push(expiry);
    },
    timeoutMs: 1000,
    maxLifetimeMs: 5000,
  });

  timer.start();

  // Activity moves the idle deadline and nothing else. Without a ceiling here the
  // CLI kept its session forever while the server, which has always had one, was
  // answering `Unknown session.` for every browser attaching to it. See ADR-039.
  for (let i = 0; i < 20; i += 1) {
    t.mock.timers.tick(900);
    timer.reset();
  }

  assert.deepEqual(expiries, ['lifetime']);

  timer.stop();
});

test('the ceiling is reported as itself, not as an idle timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const expiries: string[] = [];
  const timer = new IdleTimer({
    onExpired: (expiry) => {
      expiries.push(expiry);
    },
    timeoutMs: 1000,
    maxLifetimeMs: 1500,
  });

  timer.start();

  // Activity at 900ms leaves 600ms of ceiling against a 1000ms idle window, so the
  // ceiling is the deadline that arrives first and the one the terminal names.
  t.mock.timers.tick(900);
  timer.reset();
  t.mock.timers.tick(600);

  assert.deepEqual(expiries, ['lifetime']);

  timer.stop();
});

test('activity past the ceiling ends the session rather than extending it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const expiries: string[] = [];
  const timer = new IdleTimer({
    onExpired: (expiry) => {
      expiries.push(expiry);
    },
    timeoutMs: 1000,
    maxLifetimeMs: 800,
  });

  timer.start();

  // A long turn can finish past the ceiling, so the reset it reports arrives late.
  // Fired on a timer rather than inline, so the caller is never re-entered from
  // its own reset.
  t.mock.timers.tick(900);
  assert.deepEqual(expiries, ['lifetime']);

  // Ending is final, so the late reset arms nothing: reporting the session over
  // twice would print the terminal's goodbye twice.
  timer.reset();
  t.mock.timers.tick(1000);

  assert.deepEqual(expiries, ['lifetime']);

  timer.stop();
});

test('an idle session reports the idle window, not the ceiling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

  const expiries: string[] = [];
  const timer = new IdleTimer({
    onExpired: (expiry) => {
      expiries.push(expiry);
    },
    timeoutMs: 1000,
    maxLifetimeMs: 60000,
  });

  timer.start();
  t.mock.timers.tick(1000);

  // Naming the ceiling here would describe a limit that is not what ran out, and
  // send the user looking at the wrong setting.
  assert.deepEqual(expiries, ['idle']);

  timer.stop();
});

test('starting a clock that is already running changes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fired = 0;
  const timer = new IdleTimer({
    onExpired: () => {
      fired += 1;
    },
    timeoutMs: 1000,
  });

  timer.start();
  t.mock.timers.tick(900);

  // What a reconnect does: the CLI registers again, having been away. Registering is
  // not conversation, so it must not hand the session another hour. Restarting the
  // clock here is what let a dropped connection keep an unused session alive forever.
  // See ADR-044.
  timer.start();
  t.mock.timers.tick(100);

  assert.equal(fired, 1);

  timer.stop();
});
