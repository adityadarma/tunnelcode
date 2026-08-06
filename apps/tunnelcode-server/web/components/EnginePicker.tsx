import { SearchableSelect } from './SearchableSelect.js';

interface EnginePickerProps {
  engines: string[];
  selected: string | undefined;
  disabled?: boolean;
  onChange: (engine: string | undefined) => void;
}

/**
 * Searchable engine selector.
 *
 * Thin wrapper around SearchableSelect configured for the field variant used
 * inside modals and form groups. The gear icon distinguishes it from the model
 * star at a glance.
 */
export function EnginePicker({
  engines,
  selected,
  disabled = false,
  onChange,
}: EnginePickerProps): React.JSX.Element {
  return (
    <SearchableSelect
      id="modal-engine"
      label="Engine"
      options={engines}
      selected={selected}
      emptyLabel="No engines available"
      placeholder="Search engine..."
      disabled={disabled}
      onChange={onChange}
      variant="field"
    />
  );
}
