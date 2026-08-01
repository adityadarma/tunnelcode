import { useState } from 'react';
import { PROMPT_MAX_LENGTH } from '@tunnelcode/protocol';

interface ComposerProps {
  disabled: boolean;
  disabledReason: string | undefined;
  onSend: (text: string) => void;
  modelPicker?: React.ReactNode;
}

/**
 * Prompt input. Enter sends, Shift+Enter adds a line, which matches what people
 * expect from a chat box while still allowing multi-line prompts.
 */
export function Composer({
  disabled,
  disabledReason,
  onSend,
  modelPicker,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');

  const trimmed = text.trim();
  const tooLong = trimmed.length > PROMPT_MAX_LENGTH;

  const send = (): void => {
    // Said here as well as enforced on the server, because the server can only
    // answer a rejected frame with "invalid message", which tells the user nothing
    // about the one thing they could fix. See ADR-030.
    if (trimmed === '' || disabled || tooLong) {
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
          <div className="composer-toolbar-left">
            {modelPicker}
            {tooLong ? (
              <span className="composer-hint composer-hint-warning" role="alert">
                Too long by {(trimmed.length - PROMPT_MAX_LENGTH).toLocaleString()} characters.
                Shorten it or send it in parts.
              </span>
            ) : (
              <span className="composer-hint">
                Press <strong>Enter</strong> to send, <strong>Shift + Enter</strong> for newline
              </span>
            )}
          </div>
          <button
            type="submit"
            className="btn-send"
            disabled={disabled || trimmed === '' || tooLong}
          >
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
