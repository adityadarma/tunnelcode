import { useCallback, useEffect, useState } from 'react';
import { ConversationPage } from './pages/ConversationPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { clearStoredSession, readStoredSession, storeSession, takeCodeFromUrl } from './storage.js';
import { useRoute } from './useRoute.js';

/**
 * Chooses between pairing and conversation.
 *
 * The code is read from the URL once at startup and removed from the address
 * bar, so it does not stay in browser history.
 */
export function App(): React.JSX.Element {
  const [codeFromUrl, setCodeFromUrl] = useState(takeCodeFromUrl);
  const [sessionId, setSessionId] = useState<string | undefined>(readStoredSession);
  const { route, goToConversation, goToLogin } = useRoute();

  const handlePaired = useCallback(
    (id: string): void => {
      // A code is single use, so keeping it would only let it be tried again.
      setCodeFromUrl(undefined);
      storeSession(id);
      setSessionId(id);
      goToConversation();
    },
    [goToConversation],
  );

  const handleSessionLost = useCallback((): void => {
    // Dropped as well: the code that opened this session cannot open another, and
    // reusing it would put the pairing screen straight into a failed attempt.
    setCodeFromUrl(undefined);
    clearStoredSession();
    setSessionId(undefined);
    goToLogin();
  }, [goToLogin]);

  // Landing on /conversation without a stored session cannot render anything, so
  // the URL is corrected instead of showing an empty page.
  useEffect(() => {
    if (route.name === 'conversation' && sessionId === undefined) {
      goToLogin();
    }
  }, [route, sessionId, goToLogin]);

  // A returning visitor already has a session, so the pairing screen would only
  // be in the way. A code in the URL means pairing was asked for on purpose.
  useEffect(() => {
    if (route.name === 'login' && sessionId !== undefined && codeFromUrl === undefined) {
      goToConversation();
    }
  }, [route, sessionId, codeFromUrl, goToConversation]);

  if (route.name === 'conversation' && sessionId !== undefined) {
    return <ConversationPage sessionId={sessionId} onSessionLost={handleSessionLost} />;
  }

  return <LoginPage initialCode={codeFromUrl} onPaired={handlePaired} />;
}
