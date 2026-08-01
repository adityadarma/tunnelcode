import { useEffect, useRef, useState } from 'react';

interface ModelPickerProps {
  models: string[];
  selected: string | undefined;
  disabled: boolean;
  onChange: (model: string | undefined) => void;
}

const DEFAULT_VALUE = '__default__';

/**
 * Searchable model selector for the open conversation.
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const availableModels = Array.from(new Set([...(selected ? [selected] : []), ...models]));
  const currentDisplay = selected ?? availableModels[0] ?? 'Engine default';

  const filteredModels = availableModels.filter((m) =>
    m.toLowerCase().includes(search.toLowerCase()),
  );

  // Close dropdown when clicking outside or pressing Escape
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setSearch('');
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [open]);

  const handleSelect = (model: string) => {
    onChange(model === DEFAULT_VALUE ? undefined : model);
    setOpen(false);
  };

  return (
    <div className="model-picker" ref={containerRef}>
      <label htmlFor="model-button" className="visually-hidden">
        Model
      </label>
      <button
        id="model-button"
        type="button"
        role="combobox"
        aria-label="Model"
        aria-expanded={open}
        disabled={disabled}
        className={`model-picker-pill ${disabled ? 'disabled' : ''}`}
        title={currentDisplay}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev);
          }
        }}
      >
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
        <span className="model-picker-label">{currentDisplay}</span>
        <svg
          className={`model-picker-chevron ${open ? 'rotate-180' : ''}`}
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
      </button>

      {open && (
        <div className="model-picker-dropdown" role="listbox">
          <div className="model-picker-search-wrapper">
            <svg
              className="model-picker-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              ref={inputRef}
              type="text"
              className="model-picker-search-input"
              placeholder="Search model..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); }}
            />
            {search && (
              <button
                type="button"
                className="model-picker-search-clear"
                onClick={() => { setSearch(''); }}
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className="model-picker-options">
            {availableModels.length === 0 ? (
              <div
                role="option"
                aria-selected={selected === undefined}
                className="model-picker-option selected"
                onClick={() => { handleSelect(DEFAULT_VALUE); }}
              >
                <span>Engine default</span>
                <svg
                  className="model-picker-check"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
            ) : filteredModels.length === 0 ? (
              <div className="model-picker-no-results">No models found</div>
            ) : (
              filteredModels.map((model) => {
                const isSelected = model === (selected ?? availableModels[0]);
                return (
                  <div
                    key={model}
                    role="option"
                    aria-selected={isSelected}
                    className={`model-picker-option ${isSelected ? 'selected' : ''}`}
                    onClick={() => { handleSelect(model); }}
                  >
                    <span className="truncate">{model}</span>
                    {isSelected && (
                      <svg
                        className="model-picker-check"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
