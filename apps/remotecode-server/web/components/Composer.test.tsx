import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer.js';

describe('Composer', () => {
  test('sends the typed text', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'hello agent');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('hello agent');
  });

  test('clears the box after sending', async () => {
    render(<Composer disabled={false} disabledReason={undefined} onSend={vi.fn()} />);

    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'first prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(box).toHaveProperty('value', '');
  });

  test('enter sends the prompt', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'via enter{Enter}');

    expect(onSend).toHaveBeenCalledWith('via enter');
  });

  test('shift and enter adds a line instead of sending', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'line one{Shift>}{Enter}{/Shift}');

    // Multi-line prompts are common, so this must not submit.
    expect(onSend).not.toHaveBeenCalled();
  });

  test('whitespace alone is not sent', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), '   {Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  test('surrounding whitespace is trimmed', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), '  padded  {Enter}');

    expect(onSend).toHaveBeenCalledWith('padded');
  });

  test('a disabled composer explains why', () => {
    render(<Composer disabled={true} disabledReason="The device is offline." onSend={vi.fn()} />);

    const box = screen.getByLabelText('Message');

    expect(box).toHaveProperty('disabled', true);
    // The reason matters: the agent runs on the paired machine, so the user needs
    // to know why sending is blocked.
    expect(box.getAttribute('placeholder')).toBe('The device is offline.');
  });

  test('a disabled composer cannot send', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={true} disabledReason="Offline." onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'ignored{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });
});
