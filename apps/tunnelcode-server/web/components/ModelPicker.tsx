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
}: ModelPickerProps): React.JSX.Element {
  const availableModels = Array.from(new Set([...(selected ? [selected] : []), ...models]));

  return (
    <div className="model-picker">
      <label htmlFor="model" className="visually-hidden">
        Model
      </label>
      <div className={`model-picker-pill ${disabled ? 'disabled' : ''}`}>
        <svg
          className="model-picker-icon"
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
        <select
          id="model"
          value={selected ?? availableModels[0] ?? DEFAULT_VALUE}
          disabled={disabled}
          title={selected ?? availableModels[0] ?? 'Engine default'}
          onChange={(event) => {
            const value = event.target.value;
            onChange(value === DEFAULT_VALUE ? undefined : value);
          }}
        >
          {availableModels.length === 0 ? (
            <option value={DEFAULT_VALUE}>Engine default</option>
          ) : (
            availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))
          )}
        </select>
        <svg
          className="model-picker-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
    </div>
  );
}
