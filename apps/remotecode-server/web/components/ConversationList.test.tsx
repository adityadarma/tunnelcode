import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationList } from './ConversationList.js';

const conversations = [
  { id: 'c1', title: 'First question', createdAt: 1, updatedAt: 2 },
  { id: 'c2', title: null, createdAt: 3, updatedAt: 4 },
];

describe('ConversationList', () => {
  test('says so when there is nothing yet', () => {
    render(
      <ConversationList
        conversations={[]}
        activeId={undefined}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByText('No conversations yet.')).toBeDefined();
  });

  test('an untitled conversation still has a label', () => {
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    // A conversation is only named once its first prompt arrives, so the row must
    // not render empty until then.
    expect(screen.getByRole('button', { name: 'Untitled conversation' })).toBeDefined();
  });

  test('the active conversation is marked for assistive technology', () => {
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'First question' }).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Untitled conversation' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('selecting reports the conversation id', async () => {
    const onSelect = vi.fn();
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        onSelect={onSelect}
        onCreate={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Untitled conversation' }));

    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  test('the new button asks for a conversation', async () => {
    const onCreate = vi.fn();
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New' }));

    expect(onCreate).toHaveBeenCalledOnce();
  });
});
