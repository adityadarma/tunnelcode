import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer.js';

/**
 * Makes the component see a touch screen.
 *
 * jsdom has no matchMedia at all, which is the case the component treats as a
 * physical keyboard and what the rest of these tests rely on.
 */
function withTouchScreen(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

describe('Composer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  test('on a touch screen enter adds a line instead of sending', async () => {
    const onSend = vi.fn();
    withTouchScreen();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'line one{Enter}line two');

    // An on-screen keyboard has no Shift+Enter to reach for, so sending on Enter left
    // no way to write a second line and sent the prompt the moment it was paragraphed.
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveProperty('value', 'line one\nline two');
  });

  test('on a touch screen the send button still sends', async () => {
    const onSend = vi.fn();
    withTouchScreen();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    await userEvent.type(screen.getByLabelText('Message'), 'first{Enter}second');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('first\nsecond');
  });

  test('enter that confirms a keyboard suggestion does not send', async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} disabledReason={undefined} onSend={onSend} />);

    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'setengah');

    // A predictive keyboard confirms its suggestion with Enter, which is not a request
    // to send: the word being typed is not finished yet.
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
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
