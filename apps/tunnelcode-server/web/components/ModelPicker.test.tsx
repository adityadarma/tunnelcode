import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EngineModel } from '../api.js';
import { ModelPicker } from './ModelPicker.js';

/** A model whose id is already fit to read, which is most of them. */
const plain = (id: string): EngineModel => ({ id, label: id });

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
        models={[plain('opencode/fast'), plain('opencode/slow')]}
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
        models={[plain('opencode/fast'), plain('opencode/slow')]}
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
        models={[plain('opencode/fast'), plain('claude/sonnet'), plain('opencode/slow')]}
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
        models={[plain('opencode/fast')]}
        selected={undefined}
        disabled={true}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  /**
   * The reason a model carries two fields. Cursor's ids are parameterised and its
   * `default[]` means `Auto`, so the label is what belongs on screen while the id is
   * what the engine takes back. See ADR-051.
   */
  test('shows the label but reports the id', async () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        models={[
          { id: 'default[]', label: 'Auto' },
          { id: 'claude-opus-5[thinking=true,context=300k]', label: 'claude-opus-5' },
        ]}
        selected={undefined}
        disabled={false}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Auto',
      'claude-opus-5',
    ]);

    await userEvent.click(screen.getByText('claude-opus-5'));
    expect(onChange).toHaveBeenCalledWith('claude-opus-5[thinking=true,context=300k]');
  });

  /**
   * Searching matches the id as well as the label, so a model can still be found by
   * a bracketed parameter that is deliberately not shown.
   */
  test('finds a model by its id even when the label differs', async () => {
    render(
      <ModelPicker
        models={[
          { id: 'default[]', label: 'Auto' },
          { id: 'grok-4.5[effort=high,fast=true]', label: 'grok-4.5' },
        ]}
        selected={undefined}
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByPlaceholderText('Search model...'), 'effort=high');

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['grok-4.5']);
  });

  /**
   * A conversation can ask for a model the engine has since dropped. It stays listed
   * and stays selected, so the control says what the conversation actually asks for
   * rather than silently reading as another model.
   */
  test('keeps showing a selected model the engine no longer reports', async () => {
    render(
      <ModelPicker
        models={[plain('opencode/fast')]}
        selected="opencode/retired"
        disabled={false}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox').textContent).toContain('opencode/retired');

    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'opencode/retired',
      'opencode/fast',
    ]);
  });
});
