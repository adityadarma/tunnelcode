import { useEffect, useState } from 'react';

export type PermissionDecision = 'once' | 'always' | 'reject';

/** A tool call the agent is holding still for, waiting to be allowed. */
export interface PermissionAsk {
  conversationId: string;
  turnId: string;
  permissionId: string;
  tool: string;
  title: string;
  target?: string;
  reason?: string;
  /** Every operation this one ask covers, which can be more than one. */
  details: string[];
  /** Rules that would stop this being asked again, as the engine worded them. */
  suggestions: string[];
  createdAt: number;
  expiresAt: number;
}

interface PermissionPromptProps {
  ask: PermissionAsk;
  /** True while the device is unreachable, so an answer could not be delivered. */
  disabled?: boolean;
  onDecide: (decision: PermissionDecision) => void;
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Asks the user to decide about one tool call.
 *
 * The agent is stopped until this is answered, so it is pinned above the composer
 * rather than placed in the transcript: a card that scrolls out of view is one the
 * user never answers, and an unanswered ask ends as a refusal. See ADR-022.
 */
export function PermissionPrompt({
  ask,
  disabled = false,
  onDecide,
}: PermissionPromptProps): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const remaining = ask.expiresAt - now;
  const expired = remaining <= 0;
  const headingId = `permission-${ask.permissionId}`;

  // Repeating the target inside the list would read as two separate operations.
  const details = ask.details.filter((detail) => detail !== ask.target);

  return (
    <section className="permission" aria-labelledby={headingId}>
      <header className="permission-head">
        <h2 id={headingId} className="permission-title">
          Allow <span className="permission-tool">{ask.title}</span>?
        </h2>
        {/* Deliberately not a live region: read out every second it would talk
            over everything else on the screen. */}
        <span className="permission-clock mono">
          {expired ? 'Expired' : `${formatRemaining(remaining)} left`}
        </span>
      </header>

      {ask.reason !== undefined && <p className="permission-reason muted">{ask.reason}</p>}

      {ask.target !== undefined && (
        <p className="permission-target mono" title={ask.target}>
          {ask.target}
        </p>
      )}

      {details.length > 0 && (
        <ul className="permission-details">
          {details.map((detail) => (
            <li key={detail} className="mono">
              {detail}
            </li>
          ))}
        </ul>
      )}

      {expired ? (
        <p className="permission-expired">
          Nobody answered in time, so it was refused. Ask again to retry it.
        </p>
      ) : (
        <div className="permission-actions">
          <button
            type="button"
            className="permission-allow"
            disabled={disabled}
            onClick={() => {
              onDecide('once');
            }}
          >
            Allow once
          </button>
          <button
            type="button"
            className="permission-always"
            disabled={disabled}
            onClick={() => {
              onDecide('always');
            }}
          >
            Always allow
          </button>
          <button
            type="button"
            className="permission-deny"
            disabled={disabled}
            onClick={() => {
              onDecide('reject');
            }}
          >
            Deny
          </button>
        </div>
      )}

      {/* Named rather than implied, because "always" grants more than the one call
          on screen and the user is entitled to see how much more. See ADR-022. */}
      {!expired && ask.suggestions.length > 0 && (
        <p className="permission-scope muted">
          Always allow covers <span className="mono">{ask.suggestions.join(', ')}</span> on this
          machine.
        </p>
      )}

      {disabled && !expired && (
        <p className="permission-offline muted">
          The device is offline, so an answer cannot reach it right now.
        </p>
      )}
    </section>
  );
}
