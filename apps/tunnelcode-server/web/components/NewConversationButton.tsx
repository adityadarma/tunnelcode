import { useEffect, useRef, useState } from 'react';
import type { DeviceEngine } from '../api.js';

interface NewConversationButtonProps {
  engines: DeviceEngine[];
  disabled: boolean;
  /** Undefined engine means "whichever the terminal named". */
  onCreate: (engine: string | undefined) => void;
}

/**
 * Starts a conversation, choosing which engine it runs on.
 *
 * The engine is asked for here because this is the only moment it can be chosen:
 * a conversation keeps its engine for life, since the agent's context lives in an
 * engine session and moving it elsewhere would abandon that silently.
 * See ADR-020.
 *
 * One installed engine means there is nothing to choose, so it stays a plain
 * button rather than a menu with a single entry.
 */
export function NewConversationButton({
  engines,
  disabled,
  onCreate,
}: NewConversationButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // A menu that stays open after a click elsewhere reads as stuck, and Escape is
  // what a keyboard user reaches for first.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const icon = (
    <span aria-hidden="true" className="btn-new-icon">
      +
    </span>
  );

  if (engines.length < 2) {
    return (
      <button
        type="button"
        className="btn-new"
        disabled={disabled}
        onClick={() => {
          onCreate(undefined);
        }}
      >
        {icon} New
      </button>
    );
  }

  return (
    <div className="new-conversation" ref={containerRef}>
      <button
        type="button"
        className="btn-new"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {icon} New
      </button>

      {open && (
        <ul className="engine-menu" role="menu" aria-label="Start a conversation on">
          {engines.map((engine) => (
            <li key={engine.name}>
              <button
                type="button"
                role="menuitem"
                className="engine-menu-item"
                onClick={() => {
                  setOpen(false);
                  onCreate(engine.name);
                }}
              >
                {engine.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
