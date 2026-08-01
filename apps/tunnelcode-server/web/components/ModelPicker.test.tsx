import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './ModelPicker.js';

describe('ModelPicker', () => {
  test('shows engine default when no models are reported', async () => {
    render(<ModelPicker models={[]} selected={undefined} disabled={false} onChange={vi.fn()} />);

    await userEvent.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Engine default']);
  });

  test('offers only the models the engine reported', async () => {
    render(
      <ModelPicker
        models={['opencode/fast', 'opencode/slow']}
        selected={undefined}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option').map((option) => option.textContent);

    expect(options).toEqual(['opencode/fast', 'opencode/slow']);
  });

  test('reports the chosen model', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        models={['opencode/fast', 'opencode/slow']}
        selected={undefined}
        disabled={false}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByText('opencode/slow'));

    expect(onChange).toHaveBeenCalledWith('opencode/slow');
  });

  test('filters models when searching', async () => {
    render(
      <ModelPicker
        models={['opencode/fast', 'claude/sonnet', 'opencode/slow']}
        selected={undefined}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByPlaceholderText('Search model...'), 'claude');

    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['claude/sonnet']);
  });

  test('choosing the default reports undefined when no models are reported', async () => {
    const onChange = vi.fn();
    render(<ModelPicker models={[]} selected={undefined} disabled={false} onChange={onChange} />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Engine default' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test('is disabled while the device is offline', () => {
    render(
      <ModelPicker
        models={['opencode/fast']}
        selected={undefined}
        disabled={true}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });
});
