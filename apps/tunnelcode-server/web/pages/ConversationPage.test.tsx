import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ConversationPage } from './ConversationPage.js';

/**
 * A socket the test can push frames into.
 *
 * The real page learns everything about a running turn from the attach reply, so
 * a stub that cannot deliver messages could not exercise this at all.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static latest: FakeSocket | undefined;

  readyState = 1;
  sent: string[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    FakeSocket.latest = this;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, handler]);

    if (type === 'open') {
      handler(new Event('open'));
    }
  }

  removeEventListener(): void {}

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(): void {}

  /** Delivers a frame the way the server would. */
  deliver(message: unknown): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler({ data: JSON.stringify(message) });
    }
  }
}

const conversation = {
  id: 'conversation-1',
  title: 'Earlier question',
  engine: 'opencode',
  model: 'opencode/fast',
  createdAt: 1,
  updatedAt: 2,
};

function stubFetch(): void {
  vi.stubGlobal('fetch', (input: string) => {
    const url = input;

    const payload = url.includes('/messages')
      ? { messages: [], activities: [] }
      : url.includes('/conversations')
        ? { conversations: [conversation] }
        : {
            id: 'session-1',
            deviceName: 'Test Mac',
            workspace: '/work',
            engine: 'opencode',
            online: true,
            engines: [{ name: 'opencode', models: ['opencode/fast', 'opencode/slow'] }],
          };

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response);
  });
}

/**
 * Waits until the page has loaded its conversations and selected one.
 *
 * The composer exists before that, so attaching too early would arrive while no
 * conversation is open yet and be judged against the wrong one.
 */
async function loadPage(): Promise<void> {
  await screen.findByLabelText('Message', {}, { timeout: 4000 });
  await waitFor(() => {
    expect(screen.getAllByText(conversation.title).length).toBeGreaterThan(0);
  });
}

describe('ConversationPage turn state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubFetch();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  test('attaching with a running turn blocks the composer', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // A refresh mid-answer: the turn outlived the socket that started it. The
    // device is reported online here, so the block can only come from the turn.
    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 'conversation-1', turnId: 'turn-1' },
    });

    await waitFor(() => {
      const composer = screen.getByLabelText('Message');
      expect(composer).toHaveProperty('disabled', true);
      expect(composer.getAttribute('placeholder')).toBe('Waiting for the answer…');
    });
  });

  test('a turn that finishes frees the composer again', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 'conversation-1', turnId: 'turn-1' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true);
    });

    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    // A turn stuck on forever would be worse than the bug this fixes.
    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);
    });
  });

  test('attaching with nothing running leaves the composer usable', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });

    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);
    });
  });

  test('a turn running in another conversation says so', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // A device answers one prompt at a time, so this still blocks the open
    // conversation, and the reason has to say which case it is.
    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 'conversation-other', turnId: 'turn-9' },
    });

    await waitFor(() => {
      const composer = screen.getByLabelText('Message');
      expect(composer).toHaveProperty('disabled', true);
      expect(composer.getAttribute('placeholder')).toBe(
        'The agent is answering in another conversation.',
      );
    });
  });

  test('a malformed active turn is treated as nothing running', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // Anything crossing the socket is untrusted, so a broken shape must not
    // disable the composer indefinitely.
    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 42 },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);
    });
  });
});
