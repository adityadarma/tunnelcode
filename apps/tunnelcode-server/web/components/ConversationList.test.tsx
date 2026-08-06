import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationList } from './ConversationList.js';

const conversations = [
  {
    id: 'c1',
    title: 'First question',
    engine: 'opencode',
    model: 'opencode/fast',
    createdAt: 1,
    updatedAt: 2,
  },
  { id: 'c2', title: null, engine: 'claude', model: null, createdAt: 3, updatedAt: 4 },
];

const engines = [
  { name: 'opencode', models: ['opencode/fast'] },
  { name: 'claude', models: ['sonnet'] },
];

describe('ConversationList', () => {
  test('says so when there is nothing yet', () => {
    render(
      <ConversationList
        conversations={[]}
        activeId={undefined}
        engines={engines}
        createDisabled={false}
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
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    // A conversation is only named once its first prompt arrives, so the row must
    // not render empty until then.
    expect(screen.getByRole('button', { name: /Untitled conversation/ })).toBeDefined();
  });

  test('each row names the engine it runs on', () => {
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    // The engine is fixed per conversation, so the list is where two of them are
    // told apart.
    expect(screen.getByText('opencode', { exact: false })).toBeDefined();
    expect(screen.getByText('claude', { exact: false })).toBeDefined();
  });

  test('the active conversation is marked for assistive technology', () => {
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: /First question/ }).getAttribute('aria-current'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: /Untitled conversation/ }).getAttribute('aria-current'),
    ).toBeNull();
  });

  test('selecting reports the conversation id', async () => {
    const onSelect = vi.fn();
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={onSelect}
        onCreate={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Untitled conversation/ }));

    expect(onSelect).toHaveBeenCalledWith('c2');
  });

  test('opens modal and creates conversation with chosen engine and model', async () => {
    const onCreate = vi.fn();
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={engines.slice(0, 1)}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Conversation' }));

    expect(onCreate).toHaveBeenCalledWith('opencode', 'opencode/fast');
  });

  test('several engines allow choosing engine and model in modal', async () => {
    const onCreate = vi.fn();
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={onCreate}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Engine' }));
    await userEvent.click(screen.getByRole('option', { name: 'claude' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Conversation' }));

    expect(onCreate).toHaveBeenCalledWith('claude', 'sonnet');
  });

  test('creating is refused while the device is offline', () => {
    render(
      <ConversationList
        conversations={conversations}
        activeId="c1"
        engines={[]}
        createDisabled
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    // The engine list describes what the running CLI can serve, so there is
    // nothing to create against while it is gone.
    expect(screen.getByRole('button', { name: 'New' }).hasAttribute('disabled')).toBe(true);
  });
});
