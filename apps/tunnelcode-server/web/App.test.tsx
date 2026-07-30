import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';

/**
 * Answers the pairing calls so the app can reach the conversation screen without
 * a server. The session detail is what the conversation screen loads first.
 */
function stubFetch(): void {
  vi.stubGlobal('fetch', (input: string) => {
    const url = input;

    const payload = url.endsWith('/pair')
      ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
      : url.includes('/pair/')
        ? { status: 'approved', sessionId: 'session-1' }
        : url.includes('/conversations')
          ? { conversations: [] }
          : {
              id: 'session-1',
              deviceName: 'Test Mac',
              workspace: '/work',
              engine: 'opencode',
              online: true,
              engines: [{ name: 'opencode', models: [] }],
            };

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response);
  });

  // The conversation screen opens a socket, which jsdom does not provide.
  vi.stubGlobal(
    'WebSocket',
    class {
      static readonly OPEN = 1;
      readonly readyState = 1;
      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {}
    },
  );
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a fresh visitor sees the pairing screen', () => {
    render(<App />);

    expect(screen.getByLabelText('Pairing code')).toBeDefined();
  });

  test('pairing navigates to the conversation url', async () => {
    window.history.replaceState({}, '', '/login?code=ABCDEFGH');

    render(<App />);

    await waitFor(
      () => {
        expect(window.location.pathname).toBe('/conversation');
      },
      { timeout: 4000 },
    );
  });

  test('the conversation screen replaces the pairing screen', async () => {
    window.history.replaceState({}, '', '/login?code=ABCDEFGH');

    render(<App />);

    await waitFor(
      () => {
        expect(screen.getByLabelText('Message')).toBeDefined();
      },
      { timeout: 4000 },
    );

    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });

  test('a stored session skips the pairing screen', async () => {
    window.localStorage.setItem('tunnelcode.sessionId', 'session-1');

    render(<App />);

    // A returning visitor already paired, so asking again would be in the way.
    await waitFor(() => {
      expect(window.location.pathname).toBe('/conversation');
    });
  });

  test('a code in the url still pairs even with a stored session', () => {
    window.localStorage.setItem('tunnelcode.sessionId', 'session-1');
    window.history.replaceState({}, '', '/login?code=ABCDEFGH');

    render(<App />);

    // Scanning a new QR is a deliberate request to pair again.
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  test('landing on the conversation url without a session goes back to pairing', async () => {
    window.history.replaceState({}, '', '/conversation');

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });

    expect(screen.getByLabelText('Pairing code')).toBeDefined();
  });

  test('after disconnecting the pairing screen starts empty', async () => {
    window.history.replaceState({}, '', '/login?code=ABCDEFGH');

    render(<App />);

    // The device panel appears only once the session detail has loaded, so the
    // button has to be waited for rather than assumed present.
    const disconnect = await screen.findByRole('button', { name: 'Disconnect' }, { timeout: 4000 });

    await userEvent.click(disconnect);

    const input = await screen.findByLabelText('Pairing code');

    // The code that opened this session is single use, so reusing it would put the
    // pairing screen straight into a failed attempt.
    expect(input).toHaveProperty('value', '');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
