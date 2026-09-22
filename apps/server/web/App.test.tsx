import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';

/**
 * A socket the test can push frames into, counting every one ever opened.
 *
 * The count is the point of several of these tests: both screens read the same
 * stream, so a second connection would mean a second attach and every event
 * arriving twice.
 */
class FakeSocket {
  static readonly OPEN = 1;
  static opened: FakeSocket[] = [];

  readyState = 1;
  sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor() {
    FakeSocket.opened.push(this);
  }

  static get latest(): FakeSocket | undefined {
    return FakeSocket.opened[FakeSocket.opened.length - 1];
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

  close(): void {
    this.closed = true;
  }

  /** Delivers a frame the way the server would. */
  deliver(message: unknown): void {
    for (const handler of this.listeners.get('message') ?? []) {
      handler({ data: JSON.stringify(message) });
    }
  }

  /** The frames of one type this socket was asked to send. */
  framesOfType(type: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame['type'] === type);
  }
}

/** A conversation as the API returns one, so the composer has one to send to. */
const conversation = {
  id: 'conversation-1',
  title: 'Earlier question',
  engine: 'opencode',
  model: 'opencode/fast',
  inputTokens: null,
  outputTokens: null,
  lastInputTokens: null,
  lastOutputTokens: null,
  createdAt: 1,
  updatedAt: 2,
};

/**
 * Answers the pairing calls so the app can reach the conversation screen without
 * a server. The session detail is what the conversation screen loads first.
 */
function stubFetch(): void {
  vi.stubGlobal('fetch', (input: string) => {
    const url = input;

    // Checked before the conversations list, because a transcript's url contains
    // the word too and answering it with a list would load no messages at all.
    const payload = url.endsWith('/pair')
      ? { status: 'pending', requestId: 'req-1', approvalNumber: '1234' }
      : url.includes('/pair/')
        ? { status: 'approved', sessionId: 'session-1' }
        : url.includes('/messages')
          ? { messages: [], activities: [] }
          : url.includes('/conversations')
            ? { conversations: [conversation] }
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
  vi.stubGlobal('WebSocket', FakeSocket);
}

describe('App', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/');
    FakeSocket.opened = [];
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.opened = [];
  });

  test('a fresh visitor sees the pairing screen', () => {
    render(<App />);

    expect(screen.getByLabelText('Pairing code')).toBeDefined();
  });

  test('a visitor on /login sees the pairing screen', () => {
    window.history.replaceState({}, '', '/login');
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

  test('landing on the conversation url without a session goes back to login', async () => {
    window.history.replaceState({}, '', '/conversation');

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
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

/**
 * The changed files as the device reports them, unsorted and with the second one
 * first, so a test that finds them in order is reading the app's sorting rather
 * than the order they arrived in.
 */
const fileChangesFrame = {
  type: 'file_changes',
  sessionId: 'session-1',
  files: [
    { path: 'src/beta.ts', status: 'M', diff: '@@ -1,2 +1,2 @@\n-old beta\n+new beta' },
    { path: 'src/alpha.ts', status: 'M', diff: '@@ -1,2 +1,2 @@\n-old alpha\n+new alpha' },
  ],
};

describe('App moving between the conversation and the changed files', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, '', '/conversation');
    window.localStorage.setItem('tunnelcode.sessionId', 'session-1');
    FakeSocket.opened = [];
    stubFetch();

    // A diff scrolls to its first change, which jsdom has no implementation for.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeSocket.opened = [];
  });

  /**
   * Waits for the conversation to be usable, then reports the device as reachable.
   *
   * The composer is disabled until the socket says the device is online, so a test
   * that types without this would be typing into a box that ignores it.
   */
  async function loadConversation(): Promise<void> {
    await screen.findByLabelText('Message', {}, { timeout: 4000 });
    await waitFor(() => {
      expect(screen.getAllByText('Earlier question').length).toBeGreaterThan(0);
    });

    FakeSocket.latest?.deliver({ type: 'attached', sessionId: 'session-1', online: true });
  }

  /** The prompt box, or null when the conversation is off view. */
  function visibleComposer(): HTMLElement | null {
    return screen.queryByRole('textbox', { name: 'Message' });
  }

  /** The changed files heading, or null when that screen is off view. */
  function visibleFileList(): HTMLElement | null {
    return screen.queryByRole('heading', { name: 'Changed Files' });
  }

  test('one socket serves both screens', async () => {
    render(<App />);
    await loadConversation();

    expect(FakeSocket.opened).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });

    await userEvent.click(screen.getByRole('button', { name: 'View conversation' }));
    await waitFor(() => {
      expect(visibleComposer()).not.toBeNull();
    });

    // A screen of its own would have opened a second connection, and the server
    // would be broadcasting every event to both of them.
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.opened[0]?.closed).toBe(false);
  });

  test('only one screen is on view at a time', async () => {
    render(<App />);
    await loadConversation();

    expect(visibleComposer()).not.toBeNull();
    expect(visibleFileList()).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));

    // Both are mounted, so the one off view is still in the document. Being hidden
    // is what keeps it out of the way, and out of reach of anything reading the
    // screen.
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });
    expect(visibleComposer()).toBeNull();
    expect(screen.getByLabelText('Message')).toBeDefined();
  });

  test('a half typed prompt survives a trip to the changed files', async () => {
    render(<App />);
    await loadConversation();

    const composer = await screen.findByRole('textbox', { name: 'Message' });
    await userEvent.type(composer, 'half written thought');

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });

    await userEvent.click(screen.getByRole('button', { name: 'View conversation' }));

    // Unmounting the conversation would have thrown the text away, which is the
    // whole reason the screen is hidden instead.
    const returned = await screen.findByRole('textbox', { name: 'Message' });
    expect(returned).toHaveProperty('value', 'half written thought');
  });

  test('the changed files arrive while the conversation is on view', async () => {
    render(<App />);
    await loadConversation();

    // Delivered before that screen has ever been opened: the socket is above both of
    // them, so it is already listening.
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));

    await screen.findByText('2 files');
    expect(screen.getByText('alpha.ts')).toBeDefined();
    expect(screen.getByText('beta.ts')).toBeDefined();
  });

  test('the open diff survives a trip back to the conversation', async () => {
    render(<App />);
    await loadConversation();
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await screen.findByText('2 files');

    // Sorted, so the first one open is alpha. Picking the other is what makes the
    // selection worth remembering.
    await userEvent.click(screen.getByText('beta.ts'));
    await waitFor(() => {
      expect(screen.getByRole('option', { selected: true }).textContent).toContain('beta.ts');
    });

    await userEvent.click(screen.getByRole('button', { name: 'View conversation' }));
    await waitFor(() => {
      expect(visibleComposer()).not.toBeNull();
    });

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));

    // Coming back to the first file would be this screen having been rebuilt from
    // nothing, since that is what it opens with.
    await waitFor(() => {
      expect(screen.getByRole('option', { selected: true }).textContent).toContain('beta.ts');
    });
  });

  test('a later report replaces the diff on screen', async () => {
    render(<App />);
    await loadConversation();
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await screen.findByText('2 files');
    await userEvent.click(screen.getByText('beta.ts'));
    await screen.findByText('new beta');

    FakeSocket.latest?.deliver({
      ...fileChangesFrame,
      files: [
        { path: 'src/alpha.ts', status: 'M', diff: '@@ -1,2 +1,2 @@\n-old alpha\n+new alpha' },
        {
          path: 'src/beta.ts',
          status: 'M',
          diff: '@@ -1,2 +1,2 @@\n-old beta\n+beta edited again',
        },
      ],
    });

    // The file stays open and shows the newer diff. Holding the change itself rather
    // than its path would have left the first diff on screen for as long as it stayed
    // selected.
    await screen.findByText('beta edited again');
    expect(screen.queryByText('new beta')).toBeNull();
  });

  test('a file that stops being changed gives up the view to one that is', async () => {
    render(<App />);
    await loadConversation();
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await screen.findByText('2 files');
    await userEvent.click(screen.getByText('beta.ts'));
    await screen.findByText('new beta');

    FakeSocket.latest?.deliver({
      ...fileChangesFrame,
      files: [
        { path: 'src/alpha.ts', status: 'M', diff: '@@ -1,2 +1,2 @@\n-old alpha\n+new alpha' },
      ],
    });

    // A selection pointing at nothing would have shown the empty prompt beside a
    // sidebar with a file in it.
    await waitFor(() => {
      expect(screen.getByRole('option', { selected: true }).textContent).toContain('alpha.ts');
    });
    await screen.findByText('new alpha');
  });

  test('the open file is named once', async () => {
    render(<App />);
    await loadConversation();
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await screen.findByText('2 files');

    // The bar above the diff names the file, and the heading names the screen. Both
    // carrying the path put it on screen twice, once truncated into the other.
    expect(screen.getAllByText('src/alpha.ts')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Changed Files' })).toBeDefined();
  });

  test('arriving at the changed files asks the server to describe the session again', async () => {
    render(<App />);
    await loadConversation();

    const before = FakeSocket.latest?.framesOfType('attach').length ?? 0;

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });

    // The changed files are replayed on attach, so asking again is what fills the
    // list. The connection is untouched, which is what makes it cheap.
    await waitFor(() => {
      expect(FakeSocket.latest?.framesOfType('attach').length ?? 0).toBeGreaterThan(before);
    });
    expect(FakeSocket.opened).toHaveLength(1);
  });

  test('the changed files survive the socket dropping', async () => {
    render(<App />);
    await loadConversation();
    FakeSocket.latest?.deliver(fileChangesFrame);

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await screen.findByText('2 files');

    // The files describe the workspace rather than the connection, and the server
    // replays them on attach. Cleared here, the list would blank for the length of a
    // reconnect and then fill with the same thing.
    expect(screen.getByText('alpha.ts')).toBeDefined();
  });

  test('the changed files sidebar names the device', async () => {
    render(<App />);
    await loadConversation();

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });

    // The panel the conversation carries, on the screen beside it: which machine the
    // diffs came off, and whether it is still reachable.
    const panel = await screen.findByRole('region', { name: 'Device' });
    expect(panel.textContent).toContain('Test Mac');
    expect(panel.textContent).toContain('/work');
  });

  test('disconnecting from the changed files gives up the session', async () => {
    render(<App />);
    await loadConversation();

    await userEvent.click(screen.getByRole('button', { name: 'View changed files' }));
    await waitFor(() => {
      expect(visibleFileList()).not.toBeNull();
    });

    // Only one Disconnect is reachable: the conversation's is mounted too, but it is
    // hidden, and a hidden control is out of reach of this query for the same reason
    // it is out of reach of the user.
    const disconnect = await screen.findByRole('button', { name: 'Disconnect' });
    await userEvent.click(disconnect);

    // Ending the session sends the browser back to pairing rather than back to the
    // conversation, which is what would happen if this screen only closed itself.
    await screen.findByLabelText('Pairing code');
    expect(FakeSocket.opened[0]?.sent.some((raw) => raw.includes('"disconnect"'))).toBe(true);
  });
});
