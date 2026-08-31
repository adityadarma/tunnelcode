import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationPage } from './ConversationPage.js';
import type { Conversation } from '../api.js';

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

/**
 * A conversation as the API returns one.
 *
 * The token counts are null, which is a conversation nothing has been counted for
 * yet. Spelled out rather than left off, because that is the shape the server sends
 * and a page that only works against a payload with fields missing would not be
 * tested against anything real.
 */
/** The title, named on its own so a matcher does not have to prove it is not null. */
const TITLE = 'Earlier question';

const conversation: Conversation = {
  id: 'conversation-1',
  title: TITLE,
  engine: 'opencode',
  model: 'opencode/fast',
  inputTokens: null,
  outputTokens: null,
  lastInputTokens: null,
  lastOutputTokens: null,
  createdAt: 1,
  updatedAt: 2,
};

function stubFetch(): void {
  stubFetchWith(conversation);
}

/** The same stub, for a test that needs the conversation to carry other figures. */
function stubFetchWith(only: Conversation): void {
  vi.stubGlobal('fetch', (input: string) => {
    const url = input;

    const payload = url.includes('/messages')
      ? { messages: [], activities: [] }
      : url.includes('/conversations')
        ? { conversations: [only] }
        : {
            id: 'session-1',
            deviceName: 'Test Mac',
            workspace: '/work',
            engine: 'opencode',
            online: true,
            engines: [
              {
                name: 'opencode',
                models: [
                  { id: 'opencode/fast', label: 'opencode/fast' },
                  { id: 'opencode/slow', label: 'opencode/slow' },
                ],
              },
            ],
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
    expect(screen.getAllByText(TITLE).length).toBeGreaterThan(0);
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

  test('a stored message mid-turn keeps the typing indicator up', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 'conversation-1', turnId: 'turn-1' },
    });

    await waitFor(() => {
      expect(screen.getByText('thinking…')).toBeDefined();
    });

    // The engine flushes its buffered text as a stored message every time it
    // pauses to run a tool, so this arrives long before the turn is over. The
    // indicator has to survive it, because the tool call that follows is exactly
    // the long wait that needs feedback.
    FakeSocket.latest?.deliver({
      type: 'message',
      conversationId: 'conversation-1',
      id: 'm-1',
      role: 'assistant',
      content: 'Let me look at that file.',
      createdAt: 10,
    });

    await waitFor(() => {
      expect(screen.getByText('Let me look at that file.')).toBeDefined();
      expect(screen.getByText('thinking…')).toBeDefined();
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', true);
    });

    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    // Only the end of the turn takes it down.
    await waitFor(() => {
      expect(screen.queryByText('thinking…')).toBeNull();
      expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);
    });
  });

  test('a message arriving with no turn running raises no indicator', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });

    // A message that outlives its turn must not reopen the indicator, or the
    // composer would stay blocked with nothing on its way.
    FakeSocket.latest?.deliver({
      type: 'message',
      conversationId: 'conversation-1',
      id: 'm-2',
      role: 'assistant',
      content: 'late arrival',
      createdAt: 20,
    });

    await waitFor(() => {
      expect(screen.getByText('late arrival')).toBeDefined();
    });

    expect(screen.queryByText('thinking…')).toBeNull();
    expect(screen.getByLabelText('Message')).toHaveProperty('disabled', false);
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

describe('ConversationPage permission asks', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubFetch();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  const askFrame = {
    type: 'permission_request',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    permissionId: 'per-1',
    tool: 'Bash',
    title: 'Bash',
    target: 'curl -s https://example.com',
    reason: 'This command requires approval',
    details: ['Fetch example.com'],
    suggestions: ['Bash(curl *)'],
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  };

  const attach = (): void => {
    FakeSocket.latest?.deliver({
      type: 'attached',
      sessionId: 'session-1',
      online: true,
      activeTurn: { conversationId: 'conversation-1', turnId: 'turn-1' },
    });
  };

  function framesOfType(type: string): Record<string, unknown>[] {
    return (FakeSocket.latest?.sent ?? [])
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['type'] === type);
  }

  test('an ask is put in front of the user', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver(askFrame);

    await screen.findByRole('button', { name: 'Allow once' });
    expect(screen.getByText('This command requires approval')).toBeTruthy();

    // The composer says what is actually being waited on, which is the user rather
    // than the agent.
    expect(screen.getByLabelText('Message').getAttribute('placeholder')).toBe(
      'The agent is waiting for your approval.',
    );
  });

  test('answering sends the decision and takes the card away', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver(askFrame);

    await userEvent.click(await screen.findByRole('button', { name: 'Always allow' }));

    const answers = framesOfType('permission_response');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      conversationId: 'conversation-1',
      permissionId: 'per-1',
      decision: 'always',
    });

    // Removed before the answer even lands, because the agent acts on the first
    // decision and a second press could only be ignored.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull();
    });
  });

  test('an ask answered somewhere else stops being offered here', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver(askFrame);
    await screen.findByRole('button', { name: 'Allow once' });

    // What the other tab answering looks like from here. Two browsers can be
    // attached to one session. See ADR-022.
    FakeSocket.latest?.deliver({
      type: 'permission_resolved',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      permissionId: 'per-1',
      outcome: 'once',
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    });
  });

  test('the same ask replayed twice is shown once', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver(askFrame);
    FakeSocket.latest?.deliver(askFrame);

    await screen.findByRole('button', { name: 'Allow once' });

    // Every attach replays what is waiting, so the same ask can arrive again after
    // a reconnect.
    expect(screen.getAllByRole('button', { name: 'Allow once' })).toHaveLength(1);
  });

  test('an ask belonging to another conversation is still surfaced', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver({
      ...askFrame,
      conversationId: 'conversation-2',
      turnId: 'turn-2',
    });

    // A device answers one prompt at a time, so this is what is holding the whole
    // session up. Hiding it would leave the agent stalled with nothing on screen
    // to explain why.
    await screen.findByText(/waiting for approval in another conversation/);
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
  });

  test('a turn that ends clears its ask', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    attach();
    FakeSocket.latest?.deliver(askFrame);
    await screen.findByRole('button', { name: 'Allow once' });

    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    // Nothing is waiting for it any more, so a card offering to allow it would be
    // a button that does nothing.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    });
  });
});

describe('ConversationPage reconnect approval', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubFetch();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  test('a session waiting on the terminal shows the number instead of the conversation', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'resume_pending',
      sessionId: 'session-1',
      approvalNumber: '4271',
    });

    // Nothing on the conversation screen can be used until the terminal answers, so
    // it is replaced rather than covered.
    await screen.findByText('4271');
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  test('an approved reconnect attaches again and brings the conversation back', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'resume_pending',
      sessionId: 'session-1',
      approvalNumber: '4271',
    });
    await screen.findByText('4271');

    FakeSocket.latest?.deliver({ type: 'resume_approved', sessionId: 'session-1' });

    // Attaching again is what reports a running turn and replays a waiting ask, so
    // the resumed session lands where a fresh one does.
    await waitFor(() => {
      expect(
        FakeSocket.latest?.sent.filter((raw) => raw.includes('"attach"')).length,
      ).toBeGreaterThan(1);
    });

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });
    await screen.findByLabelText('Message');
  });

  test('a refused reconnect gives up the session', async () => {
    const lost = vi.fn();
    render(<ConversationPage sessionId="session-1" onSessionLost={lost} />);
    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'resume_rejected',
      message: 'The terminal did not allow this browser to continue.',
    });

    // The session is retired on the server, so staying on this screen would be
    // waiting for something that is never coming.
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });
});

describe('ConversationPage token counts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  test('a conversation nothing was counted for shows no figures', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // An engine that cannot count leaves the conversation here for good, and zero
    // would claim it was free.
    expect(screen.queryByText(/in ·/)).toBeNull();
  });

  test('the stored counts are shown without waiting for a turn', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 15000,
      outputTokens: 50,
      lastInputTokens: 9000,
      lastOutputTokens: 30,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // Read from the conversation, which is what makes them survive a refresh: the
    // figures used to live only in this page's state and vanished with it.
    //
    // Every figure is the conversation's, so the three of them add up. The pill used to
    // lead with the last turn's 9.0k in and 30 out beside a 15.1k total, which put two
    // scopes in one line and read as arithmetic that was wrong. See ADR-060.
    await waitFor(() => {
      expect(screen.getByText('15.0k in · 50 out · 15.1k total')).toBeDefined();
    });
  });

  test('the last turn is named in the tooltip rather than on the pill', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 15000,
      outputTokens: 50,
      lastInputTokens: 9000,
      lastOutputTokens: 30,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // Still reported, because a turn's input is roughly the context the conversation
    // now carries, which is a different question from what it has cost.
    await waitFor(() => {
      const pill = screen.getByText('15.0k in · 50 out · 15.1k total').closest('.token-usage');
      const title = pill?.getAttribute('title') ?? '';

      expect(title).toContain('Conversation — input: 15,000 tokens · output: 50 tokens');
      expect(title).toContain('Last turn — input: 9,000 tokens · output: 30 tokens');
    });
  });

  test('the figures sit on their own line above the controls', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 15000,
      outputTokens: 50,
      lastInputTokens: 9000,
      lastOutputTokens: 30,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    const figures = await screen.findByText('15.0k in · 50 out · 15.1k total');

    // A reading rather than a control: standing it beside the model pill and the
    // switch made a row of things to act on with a figure among them. Its own row,
    // right aligned, under the text it belongs to.
    expect(figures.closest('.composer-usage')).not.toBeNull();
    expect(figures.closest('.composer-toolbar')).toBeNull();

    // Between the text and the controls, which is the order it is read in. Checked as
    // document order because no test environment evaluates the stylesheet.
    const box = screen.getByLabelText('Message').closest('.composer-box');
    const usageRow = box?.querySelector('.composer-usage');
    const toolbar = box?.querySelector('.composer-toolbar');

    expect(usageRow).not.toBeNull();
    expect(toolbar).not.toBeNull();
    expect(usageRow?.compareDocumentPosition(toolbar as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('a finished turn updates both the turn and the total', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 6000,
      outputTokens: 20,
      lastInputTokens: 6000,
      lastOutputTokens: 20,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 9000, outputTokens: 30 },
      total: { inputTokens: 15000, outputTokens: 50 },
    });

    // The pill reports the conversation's total, so it is the `total` here that lands
    // on screen rather than what the single turn spent.
    await waitFor(() => {
      expect(screen.getByText('15.0k in · 50 out · 15.1k total')).toBeDefined();
    });
  });

  test('a turn that counted nothing leaves the figures alone', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 6000,
      outputTokens: 20,
      lastInputTokens: 6000,
      lastOutputTokens: 20,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // A server too old to send counts, or a turn nothing reported for. Either way
    // the last figures stand rather than being wiped to nothing.
    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    await waitFor(() => {
      expect(screen.getByText('6.0k in · 20 out · 6.0k total')).toBeDefined();
    });
  });

  test('a conversation counted only by a running turn still reports it', async () => {
    // No stored total to add to, which is the first turn of a conversation nobody had
    // counted. What that turn has spent is the whole of it, so the pill appears rather
    // than waiting for the turn to end.
    stubFetch();

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'turn_usage',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 4000, outputTokens: 10 },
    });

    await waitFor(() => {
      expect(screen.getByText('4.0k in · 10 out · 4.0k total')).toBeDefined();
    });
  });

  test('a turn that is still running shows what it has spent so far', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 6000,
      outputTokens: 20,
      lastInputTokens: 6000,
      lastOutputTokens: 20,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    // Reported as the engine revises it, so the answer says what it is costing while
    // it is being written. Every figure counts the running turn: what the conversation
    // has been charged sits still until the turn ends, and on its own it would not move
    // through the very turn being watched. See ADR-055.
    FakeSocket.latest?.deliver({
      type: 'turn_usage',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 8000, outputTokens: 25 },
    });

    // 6.0k stored plus the 8.0k this turn has reported, on every figure rather than
    // only on the total.
    await waitFor(() => {
      expect(screen.getByText('14.0k in · 45 out · 14.0k total')).toBeDefined();
    });

    // Replaced rather than added to, so a second report does not charge the turn
    // twice.
    FakeSocket.latest?.deliver({
      type: 'turn_usage',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 8200, outputTokens: 31 },
    });

    await waitFor(() => {
      expect(screen.getByText('14.2k in · 51 out · 14.3k total')).toBeDefined();
    });

    // The turn is charged now, so the stored total carries it and what was standing in
    // for it is dropped. Counted twice, the input would read as 22.4k.
    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 8200, outputTokens: 31 },
      total: { inputTokens: 14200, outputTokens: 51 },
    });

    await waitFor(() => {
      expect(screen.getByText('14.2k in · 51 out · 14.3k total')).toBeDefined();
    });
  });

  test('a running turn says its figures are not final', async () => {
    stubFetchWith({
      ...conversation,
      inputTokens: 6000,
      outputTokens: 20,
      lastInputTokens: 6000,
      lastOutputTokens: 20,
    });

    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);

    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'turn_usage',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      usage: { inputTokens: 8000, outputTokens: 25 },
    });

    // Said in the tooltip rather than done to the numbers, because a marker on the
    // figure would be decorating a count the engine reported. See ADR-055.
    await waitFor(() => {
      const pill = screen.getByText('14.0k in · 45 out · 14.0k total').closest('.token-usage');
      const title = pill?.getAttribute('title') ?? '';

      expect(title).toContain('A turn is still running');
      expect(title).toContain('This turn — input: 8,000 tokens · output: 25 tokens');
    });
  });
});

describe('ConversationPage stopping an answer', () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubFetch();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  test('a running answer offers Stop instead of a Send nobody can press', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });
    expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy();

    // Arrives before any output, so even an engine that says nothing can be stopped.
    FakeSocket.latest?.deliver({
      type: 'turn_started',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();

    // The disabled composer takes pointer events away from everything inside it, so
    // wearing that class while holding the stop button made the button unpressable.
    // Checked here because no test environment evaluates the stylesheet, which is
    // exactly why clicking below kept passing while the real button did nothing.
    const box = screen.getByLabelText('Message');
    expect(box.closest('.composer-box')?.className).not.toContain('disabled');

    // The box around it being usable is not the box itself being usable: a prompt
    // cannot be sent until the answer ends, so the field stays shut and says so.
    expect((box as HTMLTextAreaElement).disabled).toBe(true);

    await userEvent.click(stop);

    // The turn is named, so a tap landing just after one answer ended cannot end the
    // next one.
    const sent = FakeSocket.latest?.sent.map((raw) => JSON.parse(raw) as { type: string }) ?? [];
    expect(sent.some((message) => message.type === 'stop_turn')).toBe(true);
    expect(FakeSocket.latest?.sent.some((raw) => raw.includes('turn-1'))).toBe(true);
  });

  test('the composer comes back when the stopped turn ends', async () => {
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({
      type: 'turn_started',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });
    await screen.findByRole('button', { name: 'Stop' });

    // Nothing is cleared when Stop is pressed: the server ending the turn is what
    // closes this, so a stop that never arrived cannot leave the page pretending it
    // did.
    FakeSocket.latest?.deliver({
      type: 'message',
      conversationId: 'conversation-1',
      id: 'message-1',
      role: 'assistant',
      content: 'half an answer',
      partial: true,
      interruption: 'stopped',
      createdAt: 3,
    });
    FakeSocket.latest?.deliver({
      type: 'turn_done',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    await screen.findByRole('button', { name: 'Send' });

    // Said in the transcript rather than in a banner, because a banner is gone by
    // the next reload and this is part of what happened.
    await screen.findByText(/You stopped this answer/);
  });
});

describe('ConversationPage autopilot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.latest = undefined;
  });

  function autopilotFrames(): Record<string, unknown>[] {
    return (FakeSocket.latest?.sent ?? [])
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['type'] === 'set_autopilot');
  }

  test('a conversation starts with the switch off', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });

    // Nothing starts allowed, including a conversation from a server that predates
    // the field and sends no such value at all.
    const toggle = await screen.findByRole('switch', { name: 'Turn autopilot on' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  test('the model comes before the switch, and the switch is labelled', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });

    const toolbar = screen.getByLabelText('Message').closest('.composer-box');
    const model = toolbar?.querySelector('.model-picker');
    const toggle = await screen.findByRole('switch', { name: 'Turn autopilot on' });

    // The model is what the next prompt is sent to, so it is read before the setting
    // that governs what happens after it. Checked as document order because no test
    // environment evaluates the stylesheet.
    expect(model).not.toBeNull();
    expect(model?.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // The word stays at every width. Hidden on a phone it left a bare track, and a
    // switch with no label is a control whose meaning has to be guessed — this one
    // decides whether tool calls are approved without asking.
    expect(toggle.querySelector('.autopilot-label')?.textContent).toBe('Autopilot');

    // Label first, then the track, which is the order it reads in.
    const label = toggle.querySelector('.autopilot-label');
    const track = toggle.querySelector('.autopilot-track');
    expect(label?.compareDocumentPosition(track as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('switching it on asks the server rather than deciding locally', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });
    await userEvent.click(await screen.findByRole('switch', { name: 'Turn autopilot on' }));

    expect(autopilotFrames()).toEqual([
      { type: 'set_autopilot', conversationId: 'conversation-1', enabled: true },
    ]);

    // The server decides it and broadcasts the change, so a switch that never arrived
    // must not leave the control showing a state the machine does not agree with.
    expect(
      screen.getByRole('switch', { name: 'Turn autopilot on' }).getAttribute('aria-checked'),
    ).toBe('false');

    FakeSocket.latest?.deliver({
      type: 'autopilot_changed',
      conversationId: 'conversation-1',
      enabled: true,
    });

    await screen.findByRole('switch', { name: /Autopilot on/ });
  });

  test('a conversation already on autopilot shows it after a refresh', async () => {
    // What the server reports for a conversation switched on before this browser
    // loaded, which is the whole point of storing it rather than holding it in a tab.
    stubFetchWith({ ...conversation, autopilot: true });
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });

    const toggle = await screen.findByRole('switch', { name: /Autopilot on/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  test('the switch stays usable while an answer is running', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });
    FakeSocket.latest?.deliver({
      type: 'turn_started',
      conversationId: 'conversation-1',
      turnId: 'turn-1',
    });

    await screen.findByRole('button', { name: 'Stop' });

    // A turn already running is when this is most wanted, because it is the moment
    // the user puts the phone away. Sharing the composer's disabled state would have
    // shut the switch for exactly the wait it exists for.
    const toggle = screen.getByRole('switch', { name: 'Turn autopilot on' });
    expect(toggle).toHaveProperty('disabled', false);

    await userEvent.click(toggle);
    expect(autopilotFrames()).toHaveLength(1);
  });

  test('an unreachable machine leaves nowhere for the setting to land', async () => {
    stubFetch();
    render(<ConversationPage sessionId="session-1" onSessionLost={vi.fn()} />);
    await loadPage();

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: false });

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Turn autopilot on' })).toHaveProperty(
        'disabled',
        true,
      );
    });
  });
});
