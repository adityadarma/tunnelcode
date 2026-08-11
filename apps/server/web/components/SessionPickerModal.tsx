import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, importAgentSession, listAgentSessions } from '../api.js';
import type { AgentSessionListing, Conversation } from '../api.js';
import { AgentSessionCard } from './AgentSessionCard.js';

/** What went wrong, and whether asking again could plausibly help. */
interface PickerError {
  message: string;
  retryable: boolean;
}

/**
 * Turns a thrown value into something worth showing a reader.
 *
 * The two statuses the relay raises on its own are worded here rather than shown
 * as they arrive: 409 means the machine dropped its connection, which retrying
 * cannot fix, and 504 means it was still scanning, which retrying often can.
 * Anything else the server said is trusted to explain itself, and a throw that
 * never reached the server is a connection problem in this browser.
 */
function categorizeError(error: unknown): PickerError {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return { message: 'Device is no longer connected.', retryable: false };
    }
    if (error.status === 504) {
      return { message: 'Device took too long to respond. Try again.', retryable: true };
    }
    return { message: error.message, retryable: true };
  }
  return { message: 'Network error. Check your connection.', retryable: true };
}

/**
 * Everything the keyboard can reach, in document order.
 *
 * Queried at each Tab rather than once on open, because the body of this dialog is
 * swapped wholesale between a skeleton, a list of cards, an error and an empty
 * state, and a set collected on mount would name elements that no longer exist.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Stand-ins while the machine is scanned, shaped like the cards that replace them. */
function SessionSkeleton(): React.JSX.Element {
  return (
    <ul className="session-list">
      {[0, 1, 2].map((index) => (
        <li key={index}>
          <div className="session-skeleton">
            <span className="session-skeleton-line medium" />
            <span className="session-skeleton-line" />
            <span className="session-skeleton-line short" />
          </div>
        </li>
      ))}
    </ul>
  );
}

interface SessionPickerModalProps {
  /** Paired session the question is relayed through. */
  sessionId: string;
  /** Engine name the CLI matches, as recorded on a conversation. */
  engine: string;
  /** Same engine written as its vendor writes it, for the reader. */
  engineLabel: string;
  /** Whether the machine is still connected. */
  online: boolean;
  onImport: (conversation: Conversation) => void;
  onClose: () => void;
}

/**
 * Picks an agent session from the paired machine to continue in the browser.
 *
 * Opened from the New Conversation dialog and rendered through a portal to the
 * body for the same reason that one is: the sidebar it descends from is a
 * transformed drawer on mobile, which would otherwise become the containing block
 * and pin the overlay inside it.
 *
 * The list is asked for once per mount and again on each retry, never cached. It
 * describes what is on someone's machine right now, and a stale list would offer
 * sessions that have since moved on.
 *
 * Order is the server's. It sorts by last activity descending before relaying, so
 * sorting again here would only be a second opinion about the same field.
 *
 * Every way out — Escape, the backdrop, the close button, the footer button — is the
 * same `onClose`, since none of them import anything. Focus is borrowed on open and
 * handed back on unmount, and held inside the dialog in between.
 */
export function SessionPickerModal({
  sessionId,
  engine,
  engineLabel,
  onImport,
  onClose,
}: SessionPickerModalProps): React.JSX.Element {
  // Undefined means the request is still out, which is what separates "loading"
  // from an empty array the machine genuinely returned. The whole listing is kept
  // rather than just its sessions, because an empty array means two different
  // things depending on `supported` and each deserves its own sentence.
  const [listing, setListing] = useState<AgentSessionListing | undefined>(undefined);
  const [error, setError] = useState<PickerError | undefined>(undefined);
  // Kept apart from the list error above because the two want opposite bodies: a
  // list that never arrived has nothing to show but the failure, whereas a failed
  // import still has the cards the reader needs in order to click one again.
  const [importError, setImportError] = useState<PickerError | undefined>(undefined);
  const [importingId, setImportingId] = useState<string | undefined>(undefined);
  // Bumped by Retry so the fetch effect runs again without duplicating it here.
  const [attempt, setAttempt] = useState(0);
  // An import outlives its handler's closure, so the guard has to live somewhere
  // the closure can read after the modal is gone.
  const disposedRef = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  // Read during the first render, before the effect below moves focus, so it still
  // names whatever the reader was on when they opened this.
  const returnFocusRef = useRef<Element | null>(
    typeof document === 'undefined' ? null : document.activeElement,
  );

  useEffect(() => {
    return () => {
      disposedRef.current = true;
    };
  }, []);

  /**
   * Lends focus to the dialog and gives it back when the dialog goes away.
   *
   * The close button is the first control here and the one that is always present,
   * whatever the body currently holds, which makes it the only stable landing spot.
   *
   * Focus is only returned if the opener is still in the document: the button that
   * opened this lives in a dialog that closed on the way here, so on that path there
   * is nothing left to focus and the browser is left to its own default.
   */
  useEffect(() => {
    closeButtonRef.current?.focus();

    const opener = returnFocusRef.current;
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  /**
   * Escape leaves, and Tab stays inside.
   *
   * One listener for both keys, on the document rather than the dialog, so Escape
   * still works if focus has drifted outside — which it can, since the browser's own
   * chrome is reachable by Tab and returns focus wherever it likes. For the same
   * reason a Tab pressed from outside is pulled back to the first control rather
   * than ignored.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const card = cardRef.current;
      if (card === null) {
        return;
      }

      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }

      const active = document.activeElement;
      const inside = active !== null && card.contains(active);

      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    let disposed = false;

    setListing(undefined);
    setError(undefined);

    listAgentSessions(sessionId, engine)
      .then((result) => {
        if (!disposed) {
          setListing(result);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setError(categorizeError(cause));
        }
      });

    // A dismissed modal that is still waiting on a slow machine would otherwise
    // set state on a component nobody is looking at.
    return () => {
      disposed = true;
    };
  }, [sessionId, engine, attempt]);

  /**
   * Imports the picked session and hands the conversation up.
   *
   * Only one import is allowed at a time: `importingId` both drives the spinner on
   * the chosen card and disables the rest, so a second click cannot start a second
   * conversation from a stray double tap. A failure puts every card back within
   * reach, since clicking again is the retry the reader is offered here.
   */
  const startImport = (agentSessionId: string): void => {
    setImportingId(agentSessionId);
    setImportError(undefined);

    importAgentSession(sessionId, engine, agentSessionId)
      .then((conversation) => {
        if (!disposedRef.current) {
          onImport(conversation);
          onClose();
        }
      })
      .catch((cause: unknown) => {
        if (!disposedRef.current) {
          setImportingId(undefined);
          setImportError(categorizeError(cause));
        }
      });
  };

  const body =
    error !== undefined ? (
      <p className="session-error" role="alert">
        {error.message}
      </p>
    ) : listing === undefined ? (
      <SessionSkeleton />
    ) : !listing.supported ? (
      // `session-empty` rather than `session-error`: nothing went wrong here. The
      // machine answered, and its answer is that this engine keeps no history it
      // can read. Dressing that in the danger colour would read as a failure the
      // reader could have avoided, when it is a fact about their setup.
      //
      // The reason is printed as it arrived. The CLI writes a full sentence that
      // names the engine and says what to do instead, and it knows which of the
      // several cases applies — rewording it here could only lose that.
      <p className="session-empty">
        {listing.reason ?? `${engineLabel} sessions cannot be read on this machine.`}
      </p>
    ) : listing.sessions.length === 0 ? (
      <p className="session-empty">No agent sessions found for {engineLabel}.</p>
    ) : (
      <>
        {/* Above the list rather than in place of it: the retry for a failed import
            is another click on a card, so the cards have to stay on screen. */}
        {importError !== undefined && (
          <p className="session-error" role="alert">
            {importError.message}
          </p>
        )}
        <ul className="session-list">
          {listing.sessions.map((session) => (
            <li key={session.id}>
              <AgentSessionCard
                session={session}
                disabled={importingId !== undefined && importingId !== session.id}
                loading={importingId === session.id}
                onClick={() => {
                  startImport(session.id);
                }}
              />
            </li>
          ))}
        </ul>
      </>
    );

  // A disconnected machine leaves nothing to try, so the only honest action is to
  // leave. An unsupported engine is read the same way for the same reason: there is
  // no import to cancel, and no second attempt that would go differently. Every
  // other state keeps the way out labelled as a cancellation.
  const failure = error ?? importError;
  const unsupported = listing !== undefined && !listing.supported;
  const dismissLabel =
    unsupported || (failure !== undefined && !failure.retryable) ? 'Close' : 'Cancel';

  return createPortal(
    <div
      className="modal-overlay"
      onClick={(event) => {
        // Only the backdrop itself dismisses. A click that started on a card and
        // bubbled up here is not a click outside the dialog.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-picker-title"
      >
        <div className="modal-header">
          <h3 id="session-picker-title">Import from {engineLabel}</h3>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn-modal-close"
            aria-label="Close modal"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">{body}</div>

        <div className="modal-footer">
          <button type="button" className="btn-modal-cancel" onClick={onClose}>
            {dismissLabel}
          </button>
          {/* Only a failed list gets a Retry button; a failed import is retried by
              clicking a card, which is why the list stays visible behind the error. */}
          {error?.retryable === true && (
            <button
              type="button"
              className="btn-modal-submit"
              onClick={() => {
                setAttempt((current) => current + 1);
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
