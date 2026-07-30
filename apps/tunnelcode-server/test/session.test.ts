import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../dist/services/session.js';

test('a new request starts pending, not approved', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');

  // A correct code alone must never pair; the terminal has to approve.
  assert.equal(sessions.outcomeOf(request.id).status, 'pending');
});

test('the approval number is four digits', () => {
  const sessions = new SessionService();

  for (let i = 0; i < 500; i += 1) {
    assert.match(sessions.createPending('device-1').approvalNumber, /^[0-9]{4}$/);
  }
});

test('approving opens a session', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');
  const outcome = sessions.approve(request.id, 'device-1');

  assert.equal(outcome.status, 'approved');
  assert.equal(sessions.outcomeOf(request.id).status, 'approved');
});

test('another device cannot approve a request', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');

  const outcome = sessions.approve(request.id, 'device-2');

  assert.equal(outcome.status, 'unknown');
  // The request must stay open, not be consumed by the failed attempt.
  assert.equal(sessions.outcomeOf(request.id).status, 'pending');
});

test('rejecting closes the request', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');

  sessions.reject(request.id, 'device-1');

  assert.equal(sessions.outcomeOf(request.id).status, 'rejected');
  // A rejected request can never be approved afterwards.
  assert.equal(sessions.approve(request.id, 'device-1').status, 'rejected');
});

test('an approved request cannot be approved twice', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');
  const first = sessions.approve(request.id, 'device-1');
  const second = sessions.approve(request.id, 'device-1');

  assert.equal(first.status, 'approved');
  assert.equal(second.status, 'approved');
  // The second call must not mint a new session.
  assert.equal(
    first.status === 'approved' && second.status === 'approved'
      ? first.session.id === second.session.id
      : false,
    true,
  );
});

test('a stale request expires', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');

  // Reaches past the two minute window without waiting for it.
  request.createdAt = Date.now() - 3 * 60 * 1000;

  assert.equal(sessions.outcomeOf(request.id).status, 'expired');
  assert.equal(sessions.approve(request.id, 'device-1').status, 'expired');
});

test('an unknown request id is unknown', () => {
  const sessions = new SessionService();

  assert.equal(sessions.outcomeOf('nope').status, 'unknown');
});

test('dropping a device discards its pending requests', () => {
  const sessions = new SessionService();
  const request = sessions.createPending('device-1');

  sessions.removeByDevice('device-1');

  assert.equal(sessions.outcomeOf(request.id).status, 'unknown');
});
