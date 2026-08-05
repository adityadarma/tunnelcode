import { useCallback, useEffect, useState } from 'react';
import { ConversationPage } from './pages/ConversationPage.js';
import { FileChangesPage } from './pages/FileChangesPage.js';
import { IndexPage } from './pages/IndexPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { clearStoredSession, readStoredSession, storeSession, takeCodeFromUrl } from './storage.js';
import { useRoute } from './useRoute.js';

/**
 * Main App component choosing between Landing, Login/Pairing, Conversation, and FileChanges.
 */
export function App(): React.JSX.Element {
  const [codeFromUrl, setCodeFromUrl] = useState(takeCodeFromUrl);
  const [sessionId, setSessionId] = useState<string | undefined>(readStoredSession);
  const { route, goToLanding, goToConversation, goToFileChanges, goToLogin } = useRoute();

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
    setCodeFromUrl(undefined);
    clearStoredSession();
    setSessionId(undefined);
    goToLogin();
  }, [goToLogin]);

  // Landing on /conversation without a stored session cannot render anything, so
  // the URL is corrected instead of showing an empty page.
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

  const handleNavigateLanding = useCallback((): void => {
    // A code in the URL is single use. Clearing it here prevents the login page
    // from being shown again when the user returns to the landing page via the back button.
    setCodeFromUrl(undefined);
    goToLanding();
  }, [goToLanding]);

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

  // Landing route always wins — even if codeFromUrl is still set.
  if (route.name === 'index') {
    return <IndexPage onNavigateLogin={goToLogin} />;
  }

  // If on login route or coming from QR link with a code, show the standalone centered LoginPage
  if (route.name === 'login' || codeFromUrl !== undefined) {
    return (
      <LoginPage
        initialCode={codeFromUrl}
        onPaired={handlePaired}
        onNavigateLanding={handleNavigateLanding}
      />
    );
  }

  // Default index route (/) renders the modern IndexPage
  return <IndexPage onNavigateLogin={goToLogin} />;
}
