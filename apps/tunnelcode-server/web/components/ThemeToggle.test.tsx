import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from './ThemeToggle.js';

describe('ThemeToggle', () => {
  test('renders button with correct aria-label for dark theme', () => {
    render(<ThemeToggle theme="dark" onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Switch to Light Mode' })).toBeDefined();
  });

  test('renders button with correct aria-label for light theme', () => {
    render(<ThemeToggle theme="light" onToggle={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Switch to Dark Mode' })).toBeDefined();
  });

  test('calls onToggle when clicked', async () => {
    const onToggle = vi.fn();
    render(<ThemeToggle theme="dark" onToggle={onToggle} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
