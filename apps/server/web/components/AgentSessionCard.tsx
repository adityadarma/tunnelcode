import type { SessionSummary } from '../api.js';
import { formatRelativeTime } from './format-relative-time.js';

/** `1 message` rather than `1 messages`. */
function describeCount(messageCount: number): string {
  return `${String(messageCount)} ${messageCount === 1 ? 'message' : 'messages'}`;
}

interface AgentSessionCardProps {
  session: SessionSummary;
  /** True while another card is being imported, when this one must not fire. */
  disabled: boolean;
  /** True while this card is the one being imported. */
  loading: boolean;
  onClick: () => void;
}

/**
 * One agent session, offered for import.
 *
 * A button rather than a clickable row, so the keyboard reaches it on Tab and
 * activates it on Enter or Space without any of that being reimplemented here.
 *
 * Shows the title, the tail of the last answer, when the session was last touched,
 * and how many messages are in it. That combination is what tells two sessions on
 * the same project apart: the titles come from first prompts, which repeat.
 *
 * A blank preview renders nothing rather than an empty line, since a session whose
 * last answer was empty should not leave a gap where the text would be.
 *
 * While importing, the card keeps its own contents and gains a spinner: the reader
 * needs to see which session they picked. Its siblings carry `dimmed` instead. Both
 * are disabled, because a second import would be started against a modal that is
 * about to close.
 */
export function AgentSessionCard({
  session,
  disabled,
  loading,
  onClick,
}: AgentSessionCardProps): React.JSX.Element {
  const className = ['session-card', loading ? 'loading' : disabled ? 'dimmed' : '']
    .filter((part) => part !== '')
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
      onClick={onClick}
    >
      <span className="session-card-title">{session.title}</span>
      {session.preview !== '' && <span className="session-card-preview">{session.preview}</span>}
      <span className="session-card-meta">
        <span className="session-card-time">{formatRelativeTime(session.lastActiveAt)}</span>
        <span className="session-card-badge">{describeCount(session.messageCount)}</span>
      </span>
      {loading && <span className="session-card-spinner" aria-hidden="true" />}
    </button>
  );
}
