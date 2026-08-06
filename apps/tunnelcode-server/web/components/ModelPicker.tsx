import { SearchableSelect } from './SearchableSelect.js';

interface ModelPickerProps {
  models: string[];
  selected: string | undefined;
  disabled: boolean;
  onChange: (model: string | undefined) => void;
  /**
   * Visual variant.
   * - `pill` (default): compact inline button for the composer toolbar.
   * - `field`: full-width button for modals and form groups.
   */
  variant?: 'pill' | 'field';
  /** HTML id for the trigger button. Defaults to "model-button". */
  id?: string;
}

/**
 * Searchable model selector.
 *
 * Thin wrapper around SearchableSelect that adds the star icon (pill variant)
 * and wires the correct defaults. The engine is fixed when a conversation is
 * created, so only the model is switchable here. See ADR-020.
 */
export function ModelPicker({
  models,
  selected,
  disabled,
  onChange,
  variant = 'pill',
  id = 'model-button',
}: ModelPickerProps): React.JSX.Element {
  return (
    <SearchableSelect
      id={id}
      label="Model"
      options={models}
      selected={selected}
      emptyLabel="Engine default"
      placeholder="Search model..."
      disabled={disabled}
      onChange={onChange}
      variant={variant}
      icon={
        variant === 'pill' ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
        ) : undefined
      }
    />
  );
}
