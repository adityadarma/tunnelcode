import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationList } from './ConversationList.js';
import type { Conversation } from '../api.js';

/**
 * A conversation as the API returns one.
 *
 * The token counts default to null, which is a conversation nothing has been
 * counted for: these tests are about how a row reads, and spelling four figures out
 * in every fixture would bury what each one is actually checking.
 */
function conversation(fields: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: null,
    engine: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    lastInputTokens: null,
    lastOutputTokens: null,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

const conversations = [
  conversation({
    id: 'c1',
    title: 'First question',
    engine: 'opencode',
    model: 'opencode/fast',
    createdAt: 1,
    updatedAt: 2,
  }),
  conversation({ id: 'c2', engine: 'claude', createdAt: 3, updatedAt: 4 }),
];

const engines = [
  {
    name: 'opencode',
    label: 'OpenCode',
    models: [{ id: 'opencode/fast', label: 'Fast' }],
  },
  { name: 'claude', label: 'Claude Code', models: [{ id: 'sonnet', label: 'sonnet' }] },
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

    // The engine is offered under the name its vendor uses, not the name a
    // conversation records: `claude` is Claude Code and `opencode` is OpenCode.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'OpenCode',
      'Claude Code',
    ]);

    await userEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Conversation' }));

    // Chosen by label, recorded by name. See ADR-051.
    expect(onCreate).toHaveBeenCalledWith('claude', 'sonnet');
  });

  test('a row names the engine and model as they are shown, not as they are stored', () => {
    render(
      <ConversationList
        conversations={[
          conversation({
            id: 'c1',
            title: 'A conversation',
            engine: 'opencode',
            model: 'opencode/fast',
          }),
        ]}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByText('OpenCode · Fast')).toBeDefined();
  });

  test('a row falls back to what is stored when the engine is gone', () => {
    // A conversation created on an engine since uninstalled still says what it runs
    // on, rather than reading as blank.
    render(
      <ConversationList
        conversations={[
          conversation({
            id: 'c1',
            title: 'A conversation',
            engine: 'retired',
            model: 'retired/model',
          }),
        ]}
        activeId="c1"
        engines={engines}
        createDisabled={false}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(screen.getByText('retired · retired/model')).toBeDefined();
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
