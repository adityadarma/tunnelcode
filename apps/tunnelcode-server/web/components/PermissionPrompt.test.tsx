import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionPrompt } from './PermissionPrompt.js';
import type { PermissionAsk } from './PermissionPrompt.js';

const now = 1_700_000_000_000;

function ask(overrides: Partial<PermissionAsk> = {}): PermissionAsk {
  return {
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    permissionId: 'per-1',
    tool: 'Bash',
    title: 'Bash',
    target: 'curl -s https://example.com',
    reason: 'This command requires approval',
    details: ['curl -s https://example.com', 'echo done', 'ls -l'],
    suggestions: ['Bash(curl *)'],
    createdAt: now,
    expiresAt: now + 600_000,
    ...overrides,
  };
}

describe('PermissionPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('names the tool and why it is asking', () => {
    render(<PermissionPrompt ask={ask()} onDecide={vi.fn()} />);

    expect(screen.getByRole('heading').textContent).toContain('Bash');
    expect(screen.getByText('This command requires approval')).toBeTruthy();
    expect(screen.getByTitle('curl -s https://example.com')).toBeTruthy();
  });

  test('shows every operation the ask covers', () => {
    render(<PermissionPrompt ask={ask()} onDecide={vi.fn()} />);

    // One ask can cover several commands, and showing only the first would hide
    // part of what is being agreed to. See ADR-022.
    expect(screen.getByText('echo done')).toBeTruthy();
    expect(screen.getByText('ls -l')).toBeTruthy();

    // The one already shown as the target is not repeated as a separate operation.
    expect(screen.getAllByText('curl -s https://example.com')).toHaveLength(1);
  });

  test('says how far a lasting grant reaches', () => {
    render(<PermissionPrompt ask={ask()} onDecide={vi.fn()} />);

    // Always allow grants more than the call on screen, so the extra scope is
    // named rather than left implied.
    expect(screen.getByText(/Bash\(curl \*\)/)).toBeTruthy();
  });

  test('reports each decision', async () => {
    const onDecide = vi.fn();
    render(<PermissionPrompt ask={ask()} onDecide={onDecide} />);

    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(onDecide).toHaveBeenLastCalledWith('once');

    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(onDecide).toHaveBeenLastCalledWith('always');

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onDecide).toHaveBeenLastCalledWith('reject');
  });

  test('counts down towards the deadline', async () => {
    render(<PermissionPrompt ask={ask({ expiresAt: now + 65_000 })} onDecide={vi.fn()} />);

    expect(screen.getByText('1:05 left')).toBeTruthy();

    // Advancing the timers moves the clock as well, so the time is not set
    // separately: doing both would count the same ten seconds twice.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByText('0:55 left')).toBeTruthy();
  });

  test('an ask past its deadline cannot be answered', () => {
    const onDecide = vi.fn();
    render(<PermissionPrompt ask={ask({ expiresAt: now - 1000 })} onDecide={onDecide} />);

    // The server has already refused it by now, so offering buttons would only
    // invite a decision that goes nowhere.
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(screen.getByText(/Nobody answered in time/)).toBeTruthy();
  });

  test('an offline device blocks answering and says so', () => {
    render(<PermissionPrompt ask={ask()} disabled={true} onDecide={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Allow once' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/device is offline/)).toBeTruthy();
  });

  test('an ask with nothing extra to say still renders', () => {
    // Built without the optional fields rather than with them set to undefined,
    // which is what an engine that says nothing about them actually sends.
    const sparse: PermissionAsk = {
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      permissionId: 'per-1',
      tool: 'Bash',
      title: 'Bash',
      details: [],
      suggestions: [],
      createdAt: now,
      expiresAt: now + 600_000,
    };

    render(<PermissionPrompt ask={sparse} onDecide={vi.fn()} />);

    // Both engines leave some of these out, so a sparse ask must not break the
    // only screen that can release the agent.
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
  });
});
