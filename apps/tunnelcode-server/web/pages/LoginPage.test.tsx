import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './LoginPage.js';

interface FetchCall {
  url: string;
  body: unknown;
}

/**
 * Replaces fetch so the pairing screen can be driven without a server.
 * Returns the calls made, which is how "the code was sent as typed" is checked.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown): FetchCall[] {
  const calls: FetchCall[] = [];

  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    // Only strings are ever sent from this app, so anything else is a mistake
    // worth failing on rather than stringifying into nonsense.
    const body = init?.body;
    calls.push({
      url: input,
      body: typeof body === 'string' ? JSON.parse(body) : undefined,
    });

    const payload = handler(input, init);

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response);
  });

  return calls;
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('shows the code form when there is no code in the url', () => {
    render(<LoginPage initialCode={undefined} onPaired={vi.fn()} />);

    expect(screen.getByLabelText('Pairing code')).toBeDefined();
  });

  test('rejects a code that is not eight letters', async () => {
    const calls = stubFetch(() => ({}));
    render(<LoginPage initialCode={undefined} onPaired={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Pairing code'), 'ABC');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    // A malformed code must not even reach the server.
    expect(calls).toHaveLength(0);
  });

  test('rejects a lowercase code without normalising it', async () => {
    const calls = stubFetch(() => ({}));
    render(<LoginPage initialCode={undefined} onPaired={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Pairing code'), 'abcdefgh');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    // Matching is case sensitive, so silently upper-casing would let a
    // wrong-case code pair.
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  test('shows the approval number and keeps waiting', async () => {
    stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '0417' }
        : { status: 'pending' },
    );

    const onPaired = vi.fn();
    render(<LoginPage initialCode="ABCDEFGH" onPaired={onPaired} />);

    // The leading zero has to survive, it is part of what the user compares.
    expect(await screen.findByText('0417')).toBeDefined();
    expect(onPaired).not.toHaveBeenCalled();
  });

  test('reports the session once the terminal approves', async () => {
    stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
        : { status: 'approved', sessionId: 'session-1' },
    );

    const onPaired = vi.fn();
    render(<LoginPage initialCode="ABCDEFGH" onPaired={onPaired} />);

    // The page polls every second, so the wait has to outlast one interval.
    await waitFor(
      () => {
        expect(onPaired).toHaveBeenCalledWith('session-1');
      },
      { timeout: 4000 },
    );
  });

  test('shows a rejection instead of pairing', async () => {
    stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
        : { status: 'rejected' },
    );

    const onPaired = vi.fn();
    render(<LoginPage initialCode="ABCDEFGH" onPaired={onPaired} />);

    expect(await screen.findByText('Request rejected', {}, { timeout: 4000 })).toBeDefined();
    expect(onPaired).not.toHaveBeenCalled();
  });

  test('shows an expiry instead of pairing', async () => {
    stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
        : { status: 'expired' },
    );

    render(<LoginPage initialCode="ABCDEFGH" onPaired={vi.fn()} />);

    expect(await screen.findByText('Request expired', {}, { timeout: 4000 })).toBeDefined();
  });

  test('sends the code exactly as it came from the url', async () => {
    const calls = stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
        : { status: 'pending' },
    );

    render(<LoginPage initialCode="ZXCVBNMA" onPaired={vi.fn()} />);

    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });

    expect(calls[0]?.body).toEqual({ code: 'ZXCVBNMA' });
  });

  test('editing the code clears a stale error', async () => {
    stubFetch(() => ({}));
    render(<LoginPage initialCode={undefined} onPaired={vi.fn()} />);

    const input = screen.getByLabelText('Pairing code');
    await userEvent.type(input, 'ABC');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    expect(await screen.findByRole('alert')).toBeDefined();

    // The message describes the code that was submitted, so editing must clear it
    // rather than leave a complaint about text that is gone.
    await userEvent.type(input, 'DEFGH');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a rejected code can be corrected and retried', async () => {
    const calls = stubFetch((url) =>
      url.endsWith('/pair')
        ? { status: 'pending', requestId: 'req-1', approvalNumber: '4242' }
        : { status: 'pending' },
    );

    render(<LoginPage initialCode={undefined} onPaired={vi.fn()} />);

    const input = screen.getByLabelText('Pairing code');
    await userEvent.type(input, 'abcdefgh');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(calls).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, 'ABCDEFGH');
    await userEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    // The corrected code has to reach the server, not be blocked by the old error.
    expect(await screen.findByText('4242')).toBeDefined();
    expect(calls[0]?.body).toEqual({ code: 'ABCDEFGH' });
  });
});
