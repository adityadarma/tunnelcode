import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConversation, listConversations, startPairing } from './api.js';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Replaces fetch and records what the client sent, so the assertions can look at
 * the request rather than at a mocked response shape.
 */
function captureFetch(body: unknown = {}): Call[] {
  const calls: Call[] = [];

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  return calls;
}

const contentTypeOf = (call: Call | undefined): string | null =>
  new Headers(call?.init?.headers).get('content-type');

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a request with a body declares json', async () => {
    const calls = captureFetch({ status: 'pending', requestId: 'r1', approvalNumber: '1234' });

    await startPairing('ABCDEFGH');

    expect(contentTypeOf(calls.at(0))).toBe('application/json');
    expect(calls.at(0)?.init?.body).toBe(JSON.stringify({ code: 'ABCDEFGH' }));
  });

  test('a post without a body sends no content type', async () => {
    const calls = captureFetch({ id: 'c1', title: null, createdAt: 1, updatedAt: 1 });

    await createConversation('session-1');

    // Announcing json without sending anything makes the server reject the
    // request as an empty json body, which broke creating a conversation.
    expect(contentTypeOf(calls.at(0))).toBeNull();
    expect(calls.at(0)?.init?.body).toBeUndefined();
  });

  test('a get sends no content type', async () => {
    const calls = captureFetch({ conversations: [] });

    await listConversations('session-1');

    expect(contentTypeOf(calls.at(0))).toBeNull();
  });

  test('ids are escaped into the path', async () => {
    const calls = captureFetch({ id: 'c1', title: null, createdAt: 1, updatedAt: 1 });

    await createConversation('a/../b');

    // A raw id would let a crafted session id reach another route.
    expect(calls.at(0)?.url).toBe('/api/sessions/a%2F..%2Fb/conversations');
  });
});
