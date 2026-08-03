import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageList } from './MessageList.js';
import type { Activity, Message, Reasoning } from '../api.js';

const messages: Message[] = [
  { id: 'm1', role: 'user', content: 'what is this', createdAt: 1700000000000 },
  { id: 'm2', role: 'assistant', content: 'a bridge', createdAt: 1700000001000 },
];

describe('MessageList', () => {
  test('invites a first prompt when empty', () => {
    render(<MessageList messages={[]} activities={[]} streaming={undefined} />);

    expect(screen.getByText(/No messages yet/)).toBeDefined();
  });

  test('renders stored history in order', () => {
    render(<MessageList messages={messages} activities={[]} streaming={undefined} />);

    expect(screen.getByText('what is this')).toBeDefined();
    expect(screen.getByText('a bridge')).toBeDefined();
  });

  test('labels roles in text, not by colour alone', () => {
    render(<MessageList messages={messages} activities={[]} streaming={undefined} />);

    // Colour alone would leave the distinction invisible to some readers.
    expect(screen.getByText('You')).toBeDefined();
    expect(screen.getByText('Assistant')).toBeDefined();
  });

  test('announces updates to assistive technology', () => {
    render(<MessageList messages={messages} activities={[]} streaming={undefined} />);

    const log = screen.getByRole('log');

    expect(log.getAttribute('aria-live')).toBe('polite');
  });

  test('shows streaming text as it arrives', () => {
    render(<MessageList messages={messages} activities={[]} streaming="partial ans" />);

    expect(screen.getByText('partial ans')).toBeDefined();
    // Text is arriving, so the turn is answering. Saying it was thinking would
    // describe the one thing it is demonstrably not doing. See ADR-038.
    expect(screen.getByText('answering…')).toBeDefined();
  });

  test('an empty streaming string still shows the typing state', () => {
    render(<MessageList messages={messages} activities={[]} streaming="" />);

    // The prompt was sent, so the user needs feedback before the first delta.
    expect(screen.getByText('thinking…')).toBeDefined();
  });

  test('a running tool call is named while the turn waits on it', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Bash', target: 'pnpm test', createdAt: 1700000002000 },
    ];

    render(<MessageList messages={messages} activities={activities} streaming="" />);

    // A minute spent on a command is work, and the line has to say so rather than
    // claiming the model is thinking. See ADR-038.
    expect(screen.getByText('running…')).toBeDefined();
    expect(screen.queryByText('thinking…')).toBeNull();
  });

  test('reading and writing are named as themselves', () => {
    const reading: Activity[] = [
      { id: 'a1', tool: 'Read', target: 'a.ts', createdAt: 1700000002000 },
    ];

    const { unmount } = render(
      <MessageList messages={messages} activities={reading} streaming="" />,
    );

    expect(screen.getByText('reading…')).toBeDefined();
    unmount();

    const writing: Activity[] = [
      { id: 'a2', tool: 'write_to_file', target: 'a.ts', createdAt: 1700000002000 },
    ];

    render(<MessageList messages={messages} activities={writing} streaming="" />);

    // Every engine names its tools differently, so the verb is read from the name
    // rather than from a list of tools this project would have to keep.
    expect(screen.getByText('writing…')).toBeDefined();
  });

  test('a finished tool call hands the turn back to thinking', () => {
    const activities: Activity[] = [
      {
        id: 'a1',
        tool: 'Read',
        target: 'a.ts',
        output: 'export function thing(): void {}',
        createdAt: 1700000002000,
      },
    ];

    render(<MessageList messages={messages} activities={activities} streaming="" />);

    // The read is over, so the wait is now the model deciding what to do with it.
    expect(screen.getByText('thinking…')).toBeDefined();
  });

  test('a finished turn shows no status line at all', () => {
    render(<MessageList messages={messages} activities={[]} streaming={undefined} />);

    expect(screen.queryByText('thinking…')).toBeNull();
    expect(screen.queryByText('answering…')).toBeNull();
  });

  test('content is rendered as text, not markup', () => {
    const injected: Message[] = [
      { id: 'm3', role: 'assistant', content: '<img src=x onerror="alert(1)">', createdAt: 1 },
    ];

    const { container } = render(
      <MessageList messages={injected} activities={[]} streaming={undefined} />,
    );

    // Engine output is untrusted input, so it must never become live markup.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeDefined();
  });

  test('an activity shows the tool and what it acted on', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Write', target: 'src/index.ts', createdAt: 1700000000500 },
    ];

    render(<MessageList messages={messages} activities={activities} streaming={undefined} />);

    expect(screen.getByText('Write')).toBeDefined();
    expect(screen.getByText('src/index.ts')).toBeDefined();
  });

  test('an activity without a target still names the tool', () => {
    const activities: Activity[] = [{ id: 'a1', tool: 'TodoWrite', createdAt: 1700000000500 }];

    render(<MessageList messages={[]} activities={activities} streaming={undefined} />);

    expect(screen.getByText('TodoWrite')).toBeDefined();
  });

  test('activities sit between the prompt and the answer', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Read', target: 'a.ts', createdAt: 1700000000500 },
    ];

    const { container } = render(
      <MessageList messages={messages} activities={activities} streaming={undefined} />,
    );

    const order = [...container.querySelectorAll('.message p, .activity')].map((node) =>
      (node.textContent ?? '').trim(),
    );

    // Placed by time, so the activity has to land after the question that caused
    // it and before the answer that followed.
    expect(order).toEqual(['what is this', 'Reada.ts', 'a bridge']);
  });

  test('a target is rendered as text, not markup', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Bash', target: '<img src=x onerror="alert(1)">', createdAt: 1 },
    ];

    const { container } = render(
      <MessageList messages={[]} activities={activities} streaming={undefined} />,
    );

    // A target comes from engine output, so it is untrusted just like a message.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeDefined();
  });

  test('a partial answer is kept and marked as unfinished', () => {
    const cutShort: Message[] = [
      { id: 'm1', role: 'user', content: 'do the thing', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: 'I got this far', partial: true, createdAt: 2 },
    ];

    render(<MessageList messages={cutShort} activities={[]} streaming={undefined} />);

    // The text the user watched arrive is still there, and it says in words that
    // it is incomplete rather than relying on styling alone.
    expect(screen.getByText('I got this far')).toBeDefined();
    expect(screen.getByText(/stopped before it finished/)).toBeDefined();
  });

  test('a completed answer carries no unfinished notice', () => {
    render(<MessageList messages={messages} activities={[]} streaming={undefined} />);

    expect(screen.queryByText(/stopped before it finished/)).toBeNull();
  });

  test('a refused tool call says it was blocked', () => {
    const activities: Activity[] = [
      {
        id: 'a1',
        tool: 'Write',
        blocked: true,
        reason:
          "requested permissions to write to /outside/note.txt, but you haven't granted it yet",
        createdAt: 1700000000500,
      },
    ];

    render(<MessageList messages={messages} activities={activities} streaming={undefined} />);

    // Said in words, not by colour alone: a call that never ran must not read
    // like one that did.
    expect(screen.getByText('blocked')).toBeDefined();
    expect(screen.getByText(/requested permissions/)).toBeDefined();
  });

  test('a tool call that ran carries no blocked label', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Bash', target: 'pnpm test', createdAt: 1700000000500 },
    ];

    render(<MessageList messages={messages} activities={activities} streaming={undefined} />);

    expect(screen.queryByText('blocked')).toBeNull();
  });

  test('a stored activity with null columns still renders', () => {
    // The shape the transcript endpoint returns: the stored row, whose empty
    // columns are null rather than absent. A null target reached .split() and
    // threw during render, which blanked the whole page since nothing catches it.
    const stored = [
      { id: 'a1', tool: 'TodoWrite', target: null, reason: null, output: null, createdAt: 1 },
    ] as unknown as Activity[];

    render(
      <MessageList messages={[]} activities={stored} streaming={undefined} workspace="/work" />,
    );

    expect(screen.getByText('TodoWrite')).toBeDefined();
  });

  test('a workspace path in a target is dropped, not marked', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Read', target: '/work/src/a.ts', createdAt: 1 },
    ];

    render(
      <MessageList messages={[]} activities={activities} streaming={undefined} workspace="/work" />,
    );

    // Every path in a transcript starts at the workspace, so what is left of one is
    // already relative to it and needs no marker to say so.
    expect(screen.getByText('src/a.ts')).toBeDefined();
  });

  test('a workspace path inside a command is dropped too', () => {
    const activities: Activity[] = [
      { id: 'a1', tool: 'Bash', target: 'ls /work/.github && cat /work/README.md', createdAt: 1 },
    ];

    render(
      <MessageList messages={[]} activities={activities} streaming={undefined} workspace="/work" />,
    );

    // A command carries paths inside it rather than as the whole of it.
    expect(screen.getByText('ls .github && cat README.md')).toBeDefined();
  });

  test('the workspace on its own stays a dot', () => {
    const activities: Activity[] = [{ id: 'a1', tool: 'Bash', target: 'ls /work', createdAt: 1 }];

    render(
      <MessageList messages={[]} activities={activities} streaming={undefined} workspace="/work" />,
    );

    // Nothing is left of it to name, and an empty target would read as a call that
    // acted on nothing.
    expect(screen.getByText('ls .')).toBeDefined();
  });

  test('a long target is kept whole', () => {
    const files = new Array(8).fill('.github/workflows/ci.yml').join(' ');
    const target = `grep -n "uses:\\|permissions:\\|pull_request_target" ${files}`;
    const activities: Activity[] = [{ id: 'a1', tool: 'Bash', target, createdAt: 1 }];

    render(<MessageList messages={[]} activities={activities} streaming={undefined} />);

    // A chained command ends in the part that matters, so cutting it hides what the
    // reader came for. The pill scrolls instead.
    expect(screen.getByText(target)).toBeDefined();
  });

  test('thinking is folded away, and opens on demand', async () => {
    const reasonings: Reasoning[] = [
      { id: 'r1', content: 'I should read the file first.', createdAt: 1700000000400 },
    ];

    render(
      <MessageList
        messages={messages}
        activities={[]}
        reasonings={reasonings}
        streaming={undefined}
      />,
    );

    // Closed by default, so a turn that thought at length still reads as a
    // conversation rather than as pages of deliberation. See ADR-037.
    expect(screen.queryByText('I should read the file first.')).toBeNull();

    const fold = screen.getByRole('button', { name: /Thought/ });
    expect(fold.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(fold);

    expect(screen.getByText('I should read the file first.')).toBeDefined();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
  });

  test('thinking never becomes part of the answer', () => {
    const reasonings: Reasoning[] = [
      { id: 'r1', content: 'deliberating out loud', createdAt: 1700000000400 },
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        activities={[]}
        reasonings={reasonings}
        streaming={undefined}
      />,
    );

    const answer = [...container.querySelectorAll('.message-text-block')].map(
      (node) => node.textContent ?? '',
    );

    // The answer is what the agent decided to say. Reading the working out as
    // though it had been said to them is exactly what the fold prevents.
    expect(answer).toEqual(['a bridge']);
  });

  test('thinking still arriving says so', () => {
    render(
      <MessageList
        messages={messages}
        activities={[]}
        streaming=""
        reasoningStream="halfway through a thought"
      />,
    );

    // Said in words rather than left to the animation, so the state survives
    // without colour or motion.
    expect(screen.getByRole('button', { name: /Thinking…/ })).toBeDefined();
  });

  test('thinking is placed by time, before the answer it led to', () => {
    const reasonings: Reasoning[] = [
      { id: 'r1', content: 'working it out', createdAt: 1700000000400 },
    ];
    const activities: Activity[] = [
      { id: 'a1', tool: 'Read', target: 'a.ts', createdAt: 1700000000500 },
    ];

    const { container } = render(
      <MessageList
        messages={messages}
        activities={activities}
        reasonings={reasonings}
        streaming={undefined}
      />,
    );

    const order = [...container.querySelectorAll('.message p, .reasoning-summary')].map((node) =>
      (node.textContent ?? '').trim(),
    );

    // A model thinks before it acts, and acts before it reports. The transcript has
    // to read in that order. See ADR-024.
    expect(order).toEqual(['what is this', 'Thought', 'Reada.ts', 'a bridge']);
  });

  test('activities alone are enough to show a transcript', () => {
    const activities: Activity[] = [{ id: 'a1', tool: 'Read', target: 'a.ts', createdAt: 1 }];

    render(<MessageList messages={[]} activities={activities} streaming={undefined} />);

    // A turn can touch files before saying anything, so the empty state would be
    // wrong here.
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });
});
