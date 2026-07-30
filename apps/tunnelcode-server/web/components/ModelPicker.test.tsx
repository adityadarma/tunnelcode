import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPicker } from './ModelPicker.js';

describe('ModelPicker', () => {
  test('is hidden when the engine reports no models', () => {
    const { container } = render(
      <ModelPicker models={[]} selected={undefined} disabled={false} onChange={vi.fn()} />,
    );

    // An engine that cannot list models must not be offered a guess.
    expect(container.firstChild).toBeNull();
  });

  test('offers only the models the engine reported', () => {
    render(
      <ModelPicker
        models={['opencode/fast', 'opencode/slow']}
        selected={undefined}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    const options = screen.getAllByRole('option').map((option) => option.textContent);

    // Engine default plus exactly the reported models, nothing invented.
    expect(options).toEqual(['Engine default', 'opencode/fast', 'opencode/slow']);
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

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'opencode/slow');

    expect(onChange).toHaveBeenCalledWith('opencode/slow');
  });

  test('choosing the default reports undefined', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        models={['opencode/fast']}
        selected="opencode/fast"
        disabled={false}
        onChange={onChange}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText('Model'), 'Engine default');

    // undefined means "let the engine decide", not a model named default.
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

    expect(screen.getByLabelText('Model')).toHaveProperty('disabled', true);
  });
});
