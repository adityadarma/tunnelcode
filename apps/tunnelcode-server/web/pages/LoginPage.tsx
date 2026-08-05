import { useEffect, useRef, useState } from 'react';
import { readPairStatus, startPairing } from '../api.js';

const POLL_INTERVAL_MS = 1000;
const CODE_PATTERN = /^[A-Z]{8}$/;

type Phase =
  | { name: 'form' }
  | { name: 'waiting'; approvalNumber: string; requestId: string }
  | { name: 'rejected' }
  | { name: 'expired' };

interface LoginPageProps {
  initialCode: string | undefined;
  onPaired: (sessionId: string) => void;
  onNavigateLanding?: () => void;
}

/**
 * Pairing screen (previous standalone centered design).
 *
 * Displays the approval number and handles pairing verification with the CLI terminal.
 */
export function LoginPage({
  initialCode,
  onPaired,
  onNavigateLanding,
}: LoginPageProps): React.JSX.Element {
  const [code, setCode] = useState(initialCode ?? '');
  const [phase, setPhase] = useState<Phase>({ name: 'form' });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string): Promise<void> => {
    if (!CODE_PATTERN.test(value)) {
      setError('A pairing code is 8 uppercase letters.');
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const pending = await startPairing(value);
      setPhase({
        name: 'waiting',
        approvalNumber: pending.approvalNumber,
        requestId: pending.requestId,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  };

  // Coming from a QR link, the code is already known, so pairing starts at once.
  const submitted = useRef(false);

  useEffect(() => {
    if (initialCode !== undefined && !submitted.current) {
      submitted.current = true;
      void submit(initialCode);
    }
  }, [initialCode]);

  useEffect(() => {
    if (phase.name !== 'waiting') {
      return;
    }

    const requestId = phase.requestId;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const status = await readPairStatus(requestId);

          if (status.status === 'approved' && status.sessionId !== undefined) {
            onPaired(status.sessionId);
            return;
          }

          if (status.status === 'rejected') {
            setPhase({ name: 'rejected' });
          }

          if (status.status === 'expired') {
            setPhase({ name: 'expired' });
          }
        } catch {
          setPhase({ name: 'expired' });
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [phase, onPaired]);

  if (phase.name === 'waiting') {
    return (
      <main className="centered">
        <div className="login-bg-glow" />
        <section className="card login-card text-center">
          <div className="brand-badge animate-pulse">
            <img src="/icon-192.png" alt="TunnelCode" width="24" height="24" />
          </div>
          <h1>Confirm on your device</h1>
          <p className="muted">This number must match the one in your terminal.</p>
          <div className="approval-container">
            <p className="approval">{phase.approvalNumber}</p>
          </div>
          <div className="waiting-spinner-row">
            <span className="pulse-dot" />
            <p className="muted">Waiting for approval…</p>
          </div>
        </section>
      </main>
    );
  }

  if (phase.name === 'rejected' || phase.name === 'expired') {
    const isRejected = phase.name === 'rejected';
    return (
      <main className="centered">
        <div className="login-bg-glow" />
        <section className="card login-card text-center">
          <div className={`brand-badge ${isRejected ? 'badge-danger' : 'badge-warning'}`}>
            {isRejected ? (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            ) : (
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            )}
          </div>
          <h1>{isRejected ? 'Request rejected' : 'Request expired'}</h1>
          <p className="muted">
            {isRejected
              ? 'The request was rejected in the terminal.'
              : 'The request timed out. Start again with a new code.'}
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setPhase({ name: 'form' });
              setCode('');
            }}
          >
            Try again
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="centered">
      <div className="login-bg-glow" />
      <section className="card login-card">
        {onNavigateLanding !== undefined && (
          <button
            type="button"
            className="back-to-landing-btn"
            onClick={onNavigateLanding}
            title="Back to Landing Page"
          >
            ← Back to Overview
          </button>
        )}
        <div className="login-header">
          <div className="brand-badge">
            <img src="/icon-192.png" alt="TunnelCode" width="24" height="24" />
          </div>
          <div className="brand-title-group">
            <h1>TunnelCode</h1>
            <p className="muted">Enter the pairing code shown in your terminal.</p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
        >
          <div className="form-group">
            <label htmlFor="code">Pairing code</label>
            <input
              id="code"
              className="code-input"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setError(undefined);
              }}
              placeholder="ABCDEFGH"
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error === undefined ? undefined : 'code-error'}
              aria-invalid={error !== undefined}
            />
          </div>
          {error !== undefined && (
            <p id="code-error" role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Pairing…' : 'Pair device'}
          </button>
        </form>

        <div className="terminal-hint-box">
          <div className="terminal-hint-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </div>
          <p className="terminal-hint-text">
            Run <code>tunnelcode</code> in your project terminal to generate a pairing code.
          </p>
        </div>
      </section>
    </main>
  );
}
