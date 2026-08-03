import { useEffect, useState } from 'react';
import { PROMPT_MAX_LENGTH } from '@tunnelcode/protocol';

interface ComposerProps {
  disabled: boolean;
  disabledReason: string | undefined;
  onSend: (text: string) => void;
  /**
   * Whether an answer is running, which turns the button into a stop.
   *
   * A disabled Send is the whole of what the user could do about a turn that has
   * gone nowhere, which is nothing. See ADR-042.
   */
  running?: boolean;
  /** Stops the running answer. Required in practice whenever running is true. */
  onStop?: () => void;
  modelPicker?: React.ReactNode;
}

/**
 * A touch screen, which is what a coarse pointer reports.
 *
 * Used to decide what Enter does, because the two keyboards disagree about it. On an
 * on-screen keyboard Enter is the only key there is for a new line: there is no
 * Shift+Enter to reach for, so sending on Enter leaves no way to write a second line
 * and a prompt gets sent the moment it is paragraphed.
 */
const TOUCH_QUERY = '(pointer: coarse)';

type QueryListener = (event: { matches: boolean }) => void;

/**
 * A media query as it can actually be relied on.
 *
 * The DOM types promise `matchMedia` and `addEventListener` unconditionally, and both
 * can be absent: jsdom provides no `matchMedia`, and a browser old enough only has the
 * deprecated `addListener`. Declared optional here so the checks below are the real
 * ones rather than dead code the linter is right to complain about.
 */
interface MediaQuery {
  matches: boolean;
  addEventListener?: (type: 'change', listener: QueryListener) => void;
  removeEventListener?: (type: 'change', listener: QueryListener) => void;
}

function touchQuery(): MediaQuery | undefined {
  return (window as { matchMedia?: (query: string) => MediaQuery }).matchMedia?.(TOUCH_QUERY);
}

/**
 * Whether this is a touch device, kept current.
 *
 * Watched rather than read once, because a tablet gains and loses a keyboard while
 * the page stays open. Anything that cannot answer the question is treated as not a
 * touch device, which keeps Enter sending where it always did.
 */
function useTouchInput(): boolean {
  const [touch, setTouch] = useState(() => touchQuery()?.matches ?? false);

  useEffect(() => {
    const query = touchQuery();
    const listen = query?.addEventListener;

    if (query === undefined || listen === undefined) {
      return;
    }

    const onChange: QueryListener = (event) => {
      setTouch(event.matches);
    };

    listen.call(query, 'change', onChange);

    return () => {
      query.removeEventListener?.('change', onChange);
    };
  }, []);

  return touch;
}

/**
 * Prompt input.
 *
 * With a physical keyboard, Enter sends and Shift+Enter adds a line, which is what
 * people expect of a chat box. On a touch screen Enter adds a line and only the Send
 * button sends. See ADR-036.
 */
export function Composer({
  disabled,
  disabledReason,
  onSend,
  running = false,
  onStop,
  modelPicker,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const touch = useTouchInput();

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

      {/* Dimmed and inert only when there is genuinely nothing to do here. A running
          answer is not that: the box carries the stop button, and the disabled state
          takes pointer events away from everything inside it, which is what made the
          stop unpressable. Each control still says whether it is disabled on its own,
          so nothing else becomes usable. See ADR-042. */}
      <div className={`composer-box ${disabled && !running ? 'disabled' : ''}`}>
        <textarea
          id="prompt"
          value={text}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? (disabledReason ?? 'Unavailable') : 'Ask the agent…'}
          onChange={(event) => {
            setText(event.target.value);
          }}
          // Tells the on-screen keyboard to offer a return key rather than a Go or
          // Send one, so the key matches what pressing it now does.
          {...(touch ? { enterKeyHint: 'enter' as const } : {})}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || touch) {
              return;
            }

            // Enter while a word is being composed confirms the suggestion the
            // keyboard is offering, which is not a request to send anything.
            if (event.nativeEvent.isComposing) {
              return;
            }

            event.preventDefault();
            send();
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
            ) : touch ? (
              <span className="composer-hint">
                <strong>Enter</strong> adds a line. <strong>Send</strong> sends.
              </span>
            ) : (
              <span className="composer-hint">
                Press <strong>Enter</strong> to send, <strong>Shift + Enter</strong> for newline
              </span>
            )}
          </div>
          {/* While an answer is running this is the only control that can do
              anything, so it is a stop rather than a Send nobody can press. It is
              not a submit: pressing Enter in the box must never stop the answer. */}
          {running ? (
            <button
              type="button"
              className="btn-send btn-stop"
              onClick={() => {
                onStop?.();
              }}
            >
              <span>Stop</span>
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
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
          )}
        </div>
      </div>
    </form>
  );
}
