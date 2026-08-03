interface ResumeApprovalProps {
  approvalNumber: string;
  workspace: string | undefined;
  /** Gives up on this session and goes back to pairing. */
  onPairAgain: () => void;
}

/**
 * Shown while the terminal decides whether this browser may carry on.
 *
 * Takes over the screen rather than sitting beside the conversation, because
 * nothing on that screen can be used: the machine will not answer a prompt or a
 * permission ask until the number below is approved. Worded as a reconnect, not a
 * pairing, since the user did not just scan anything. See ADR-040.
 */
export function ResumeApproval({
  approvalNumber,
  workspace,
  onPairAgain,
}: ResumeApprovalProps): React.JSX.Element {
  return (
    <main className="centered">
      <div className="login-bg-glow" />
      <section className="card login-card text-center">
        <div className="brand-badge animate-pulse">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="4" width="20" height="16" rx="4" />
            <path d="M7 10l4 4-4 4" />
            <path d="M13 18h4" />
          </svg>
        </div>
        <h1>Approve this reconnect</h1>
        <p className="muted">
          {workspace === undefined
            ? 'The terminal was restarted, so it has to allow this browser again.'
            : `The terminal running ${workspace} was restarted, so it has to allow this browser again.`}
        </p>
        <div className="approval-container">
          <p className="approval">{approvalNumber}</p>
        </div>
        <div className="waiting-spinner-row">
          <span className="pulse-dot" />
          <p className="muted">Waiting for approval…</p>
        </div>
        <button type="button" className="ghost" onClick={onPairAgain}>
          Pair again instead
        </button>
      </section>
    </main>
  );
}
