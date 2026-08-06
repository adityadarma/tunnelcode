import { useEffect, useRef, useState } from 'react';

interface SearchableSelectProps {
  /** Accessible name for the trigger. */
  label: string;
  options: string[];
  selected: string | undefined;
  /** Shown when options is empty. */
  emptyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string | undefined) => void;
  /**
   * Visual variant.
   * - `pill`: compact inline button used in the composer toolbar.
   * - `field`: full-width button used inside form groups and modals.
   */
  variant?: 'pill' | 'field';
  /** Icon shown before the label in pill variant. Ignored for field. */
  icon?: React.ReactNode;
  /** HTML id for the trigger button, lets external labels reference it. */
  id?: string;
}

const DEFAULT_VALUE = '__default__';

/**
 * Searchable single-choice selector.
 *
 * Lists options in a dropdown panel with a search input so the user can filter
 * long lists (dozens of models). Two visual variants share the dropdown but
 * differ in trigger style:
 *
 * - `pill` renders a compact badge matching the composer toolbar.
 * - `field` renders a full-width button matching modal form fields.
 */
export function SearchableSelect({
  label,
  options,
  selected,
  emptyLabel = 'Engine default',
  placeholder = 'Search...',
  disabled = false,
  onChange,
  variant = 'pill',
  icon,
  id,
}: SearchableSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const availableOptions = Array.from(new Set([...(selected ? [selected] : []), ...options]));
  const currentDisplay = selected ?? availableOptions[0] ?? emptyLabel;

  const filtered = availableOptions.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

  // Close dropdown when clicking outside or pressing Escape
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (variant === 'field') {
          event.stopPropagation();
        }
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown, variant === 'field');
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown, variant === 'field');
    };
  }, [open, variant]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setSearch('');
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [open]);

  const handleSelect = (value: string): void => {
    onChange(value === DEFAULT_VALUE ? undefined : value);
    setOpen(false);
  };

  const renderSearchAndOptions = (): React.JSX.Element => (
    <>
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
          placeholder={placeholder}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        {search !== '' && (
          <button
            type="button"
            className="model-picker-search-clear"
            onClick={() => {
              setSearch('');
            }}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="model-picker-options">
        {availableOptions.length === 0 ? (
          <div
            role="option"
            aria-selected={selected === undefined}
            className="model-picker-option selected"
            onClick={() => {
              handleSelect(DEFAULT_VALUE);
            }}
          >
            <span>{emptyLabel}</span>
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
        ) : filtered.length === 0 ? (
          <div className="model-picker-no-results">No matches</div>
        ) : (
          filtered.map((option) => {
            const isSelected = option === (selected ?? availableOptions[0]);
            return (
              <div
                key={option}
                role="option"
                aria-selected={isSelected}
                className={`model-picker-option ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  handleSelect(option);
                }}
              >
                <span className="truncate">{option}</span>
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
    </>
  );

  const isPill = variant === 'pill';

  if (isPill) {
    return (
      <div className="model-picker" ref={containerRef}>
        <label htmlFor={id ?? 'searchable-select-button'} className="visually-hidden">
          {label}
        </label>
        <button
          id={id ?? 'searchable-select-button'}
          type="button"
          role="combobox"
          aria-label={label}
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
          {icon && <span className="model-picker-icon">{icon}</span>}
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
          <div className="model-picker-dropdown" role="listbox" aria-label={label}>
            {renderSearchAndOptions()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="form-group" ref={containerRef}>
      <label htmlFor={id ?? 'searchable-select-button'}>{label}</label>
      <div className="modal-combo-container">
        <button
          id={id ?? 'searchable-select-button'}
          type="button"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="modal-combo-trigger"
          onClick={() => {
            if (!disabled) {
              setOpen((prev) => !prev);
            }
          }}
        >
          <span className="modal-combo-value">
            {availableOptions.length === 0 ? emptyLabel : currentDisplay}
          </span>
          <svg
            className={`modal-combo-chevron ${open ? 'rotate-180' : ''}`}
            width="14"
            height="14"
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
          <div className="modal-combo-dropdown" role="listbox" aria-label={label}>
            {renderSearchAndOptions()}
          </div>
        )}
      </div>
    </div>
  );
}
