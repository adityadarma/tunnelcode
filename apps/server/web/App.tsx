import { useCallback, useEffect, useState } from 'react';
import { ConversationPage } from './pages/ConversationPage.js';
import { FileChangesPage } from './pages/FileChangesPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { clearStoredSession, readStoredSession, storeSession, takeCodeFromUrl } from './storage.js';
import { useRoute } from './useRoute.js';

/**
 * Main App component choosing between Login/Pairing, Conversation, and FileChanges.
 */
export function App(): React.JSX.Element {
  const [codeFromUrl, setCodeFromUrl] = useState(takeCodeFromUrl);
  const [sessionId, setSessionId] = useState<string | undefined>(readStoredSession);
  const { route, goToConversation, goToFileChanges, goToLogin } = useRoute();

  const handlePaired = useCallback(
    (id: string): void => {
      setCodeFromUrl(undefined);
      storeSession(id);
      setSessionId(id);
      goToConversation();
    },
    [goToConversation],
  );

  const handleSessionLost = useCallback((): void => {
    setCodeFromUrl(undefined);
    clearStoredSession();
    setSessionId(undefined);
    goToLogin();
  }, [goToLogin]);

  // Landing on /conversation without a stored session cannot render anything.
  useEffect(() => {
    if (
      (route.name === 'conversation' || route.name === 'file-changes') &&
      sessionId === undefined
    ) {
      goToLogin();
    }
  }, [route, sessionId, goToLogin]);

  // A returning visitor already has a session, so the pairing screen would only
  // be in the way. A code in the URL means pairing was asked for on purpose.
  useEffect(() => {
    if (
      (route.name === 'login' || route.name === 'index') &&
      sessionId !== undefined &&
      codeFromUrl === undefined
    ) {
      goToConversation();
    }
  }, [route, sessionId, codeFromUrl, goToConversation]);

  if (route.name === 'conversation' && sessionId !== undefined) {
    return (
      <ConversationPage
        sessionId={sessionId}
        onSessionLost={handleSessionLost}
        onNavigateFileChanges={goToFileChanges}
      />
    );
  }

  if (route.name === 'file-changes' && sessionId !== undefined) {
    return <FileChangesPage sessionId={sessionId} onBack={goToConversation} />;
  }

  return <LoginPage initialCode={codeFromUrl} onPaired={handlePaired} />;
}
