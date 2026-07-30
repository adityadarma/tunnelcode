import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList.js';
import type { Activity, Message } from '../api.js';

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
    expect(screen.getByText('typing…')).toBeDefined();
  });

  test('an empty streaming string still shows the typing state', () => {
    render(<MessageList messages={messages} activities={[]} streaming="" />);

    // The prompt was sent, so the user needs feedback before the first delta.
    expect(screen.getByText('typing…')).toBeDefined();
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

  test('activities alone are enough to show a transcript', () => {
    const activities: Activity[] = [{ id: 'a1', tool: 'Read', target: 'a.ts', createdAt: 1 }];

    render(<MessageList messages={[]} activities={activities} streaming={undefined} />);

    // A turn can touch files before saying anything, so the empty state would be
    // wrong here.
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });
});
