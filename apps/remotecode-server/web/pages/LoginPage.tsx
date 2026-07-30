import { useEffect, useState } from 'react';
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
}

/**
 * Pairing screen.
 *
 * The approval number is shown here and has to match what the terminal shows.
 * Nothing is paired until the user approves there, so this screen only ever
 * waits. See PROJECT.md (Pairing Approval).
 */
export function LoginPage({ initialCode, onPaired }: LoginPageProps): React.JSX.Element {
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
  useEffect(() => {
    if (initialCode !== undefined) {
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
        <section className="card">
          <h1>Confirm on your device</h1>
          <p className="muted">This number must match the one in your terminal.</p>
          <p className="approval">{phase.approvalNumber}</p>
          <p className="muted">Waiting for approval…</p>
        </section>
      </main>
    );
  }

  if (phase.name === 'rejected' || phase.name === 'expired') {
    return (
      <main className="centered">
        <section className="card">
          <h1>{phase.name === 'rejected' ? 'Request rejected' : 'Request expired'}</h1>
          <p className="muted">
            {phase.name === 'rejected'
              ? 'The request was rejected in the terminal.'
              : 'The request timed out. Start again with a new code.'}
          </p>
          <button
            type="button"
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
      <section className="card">
        <h1>RemoteCode</h1>
        <p className="muted">Enter the pairing code shown in your terminal.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
        >
          <label htmlFor="code">Pairing code</label>
          <input
            id="code"
            className="code-input"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              // Editing means the user is answering the complaint, so keeping the
              // old message on screen would only describe a code that is gone.
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
          {error !== undefined && (
            <p id="code-error" role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? 'Pairing…' : 'Pair device'}
          </button>
        </form>
      </section>
    </main>
  );
}
