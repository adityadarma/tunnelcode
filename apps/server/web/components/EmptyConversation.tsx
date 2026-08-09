/**
 * What a conversation with nothing in it yet shows.
 *
 * Carries no minimum height, because the message area is the part that gives way
 * when the keyboard opens and the composer is never what disappears. On a short
 * viewport the decoration is dropped rather than cropped. See ADR-036.
 */
export function EmptyConversation(): React.JSX.Element {
  return (
    <div className="messages empty-state-container">
      <div className="empty-hero-glow" />
      <div className="empty-hero-content">
        <div className="empty-icon-badge">
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </div>
        <h2 className="empty-title">What would you like to build?</h2>
        <p className="muted empty-subtitle">No messages yet. Ask something to get started.</p>
        <div className="empty-features-grid">
          <div className="feature-chip">
            <span className="chip-icon">⚡</span>
            <span>Terminal Tunneling</span>
          </div>
          <div className="feature-chip">
            <span className="chip-icon">🔒</span>
            <span>Secure Pairing</span>
          </div>
          <div className="feature-chip">
            <span className="chip-icon">🤖</span>
            <span>Multi-Engine Selection</span>
          </div>
        </div>
      </div>
    </div>
  );
}
