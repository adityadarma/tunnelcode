interface ModelPickerProps {
  models: string[];
  selected: string | undefined;
  disabled: boolean;
  onChange: (model: string | undefined) => void;
}

const DEFAULT_VALUE = '__default__';

/**
 * Model selector for the open conversation.
 *
 * The options come from the engine that conversation was created on, so the
 * browser can never ask for a model that engine cannot serve. An engine that
 * reports no models hides the picker rather than offering a guess.
 *
 * Only the model is switchable here. The engine is fixed when the conversation is
 * created, because the agent's context lives in an engine session. See ADR-020.
 */
export function ModelPicker({
  models,
  selected,
  disabled,
  onChange,
}: ModelPickerProps): React.JSX.Element | null {
  if (models.length === 0) {
    return null;
  }

  return (
    <div className="model-picker">
      <label htmlFor="model">Model</label>
      <select
        id="model"
        value={selected ?? DEFAULT_VALUE}
        disabled={disabled}
        onChange={(event) => {
          const value = event.target.value;
          onChange(value === DEFAULT_VALUE ? undefined : value);
        }}
      >
        <option value={DEFAULT_VALUE}>Engine default</option>
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
    </div>
  );
}
