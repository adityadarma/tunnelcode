import { beforeEach, describe, expect, test } from 'vitest';
import { clearStoredSession, readStoredSession, storeSession, takeCodeFromUrl } from './storage.js';

function setUrl(search: string): void {
  window.history.replaceState({}, '', `/login${search}`);
}

describe('storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setUrl('');
  });

  test('a session survives a reload', () => {
    expect(readStoredSession()).toBeUndefined();

    storeSession('session-1');

    // A refresh must return to the conversation, not ask for a new pairing.
    expect(readStoredSession()).toBe('session-1');
  });

  test('clearing forgets the session', () => {
    storeSession('session-1');
    clearStoredSession();

    expect(readStoredSession()).toBeUndefined();
  });

  test('the code is read from the query string', () => {
    setUrl('?code=ABCDEFGH');

    expect(takeCodeFromUrl()).toBe('ABCDEFGH');
  });

  test('the code is removed from the address bar', () => {
    setUrl('?code=ABCDEFGH');
    takeCodeFromUrl();

    // The code must not linger in browser history.
    expect(window.location.search).toBe('');
  });

  test('the code is returned exactly as received', () => {
    setUrl('?code=abcdefgh');

    // Matching is case sensitive, so normalising here would let a wrong-case code
    // pair.
    expect(takeCodeFromUrl()).toBe('abcdefgh');
  });

  test('no code in the url means nothing to pair with', () => {
    expect(takeCodeFromUrl()).toBeUndefined();

    setUrl('?code=');
    expect(takeCodeFromUrl()).toBeUndefined();
  });
});
