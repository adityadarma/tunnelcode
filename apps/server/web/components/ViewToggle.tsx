interface ViewToggleProps {
  /** Which screen is on view, which decides where this button goes next. */
  view: 'conversation' | 'file-changes';
  onToggle: () => void;
}

/**
 * Switches between the conversation and the changed files.
 *
 * One button rather than one per screen: the two are alternatives, and the icon
 * names where it goes rather than where it already is.
 */
export function ViewToggle({ view, onToggle }: ViewToggleProps): React.JSX.Element {
  const onConversation = view === 'conversation';
  const label = onConversation ? 'View changed files' : 'View conversation';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={label}
      title={onConversation ? 'Changed files' : 'Conversation'}
    >
      {onConversation ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="15" x2="15" y2="15" />
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )}
    </button>
  );
}
