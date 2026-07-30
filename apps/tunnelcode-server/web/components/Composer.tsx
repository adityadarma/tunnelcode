import { useState } from 'react';

interface ComposerProps {
  disabled: boolean;
  disabledReason: string | undefined;
  onSend: (text: string) => void;
}

/**
 * Prompt input. Enter sends, Shift+Enter adds a line, which matches what people
 * expect from a chat box while still allowing multi-line prompts.
 */
export function Composer({ disabled, disabledReason, onSend }: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');

  const send = (): void => {
    const trimmed = text.trim();

    if (trimmed === '' || disabled) {
      return;
    }

    onSend(trimmed);
    setText('');
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="visually-hidden" htmlFor="prompt">
        Message
      </label>

      <div className={`composer-box ${disabled ? 'disabled' : ''}`}>
        <textarea
          id="prompt"
          value={text}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? (disabledReason ?? 'Unavailable') : 'Ask the agent…'}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />

        <div className="composer-toolbar">
          <span className="composer-hint">
            Press <strong>Enter</strong> to send, <strong>Shift + Enter</strong> for newline
          </span>
          <button type="submit" className="btn-send" disabled={disabled || text.trim() === ''}>
            <span>Send</span>
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
}
