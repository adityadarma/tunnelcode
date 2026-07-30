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
