import { SearchableSelect } from './SearchableSelect.js';

/** The two facts the picker needs: what to record, and what to show. */
export interface EngineChoice {
  name: string;
  label: string;
}

interface EnginePickerProps {
  engines: EngineChoice[];
  /** The engine name a conversation records, not its label. */
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
 *
 * The label is shown and the name is reported, for the same reason a model carries
 * both: `opencode` is called OpenCode and `claude` is Claude Code, and neither
 * spelling can be derived from the name that is stored. See ADR-051.
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
      options={engines.map((engine) => ({ value: engine.name, label: engine.label }))}
      selected={selected}
      emptyLabel="No engines available"
      placeholder="Search engine..."
      disabled={disabled}
      onChange={onChange}
      variant="field"
    />
  );
}
