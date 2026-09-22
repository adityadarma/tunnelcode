import { Activity as KeepAlive, useCallback, useEffect, useState } from 'react';
import { SessionSocketProvider } from './SessionSocketContext.js';
import { ConversationPage } from './pages/ConversationPage.js';
import { FileChangesPage } from './pages/FileChangesPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { clearStoredSession, readStoredSession, storeSession, takeCodeFromUrl } from './storage.js';
import { useRoute } from './useRoute.js';
import { useTheme } from './useTheme.js';

/**
 * Main App component choosing between Login/Pairing, Conversation, and FileChanges.
 */
export function App(): React.JSX.Element {
  const [codeFromUrl, setCodeFromUrl] = useState(takeCodeFromUrl);
  const [sessionId, setSessionId] = useState<string | undefined>(readStoredSession);
  const { route, goToConversation, goToFileChanges, goToLogin } = useRoute();
  const { theme, toggleTheme } = useTheme();

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

  if (sessionId === undefined) {
    return <LoginPage initialCode={codeFromUrl} onPaired={handlePaired} />;
  }

  // A code in the URL is a deliberate request to pair again, so the pairing screen
  // wins over the session that is already stored. The effect above navigates once
  // that code has been dealt with.
  if (route.name === 'login' && codeFromUrl !== undefined) {
    return <LoginPage initialCode={codeFromUrl} onPaired={handlePaired} />;
  }

  // Both screens stay mounted and are hidden rather than unmounted, so moving
  // between them keeps what each had on screen: the conversation keeps its
  // transcript, scroll and half typed prompt, and the file list keeps which diff was
  // open. The socket is above them, so neither hiding one nor showing the other
  // touches the connection. See ADR-007.
  return (
    <SessionSocketProvider key={sessionId} sessionId={sessionId}>
      <KeepAlive mode={route.name === 'file-changes' ? 'hidden' : 'visible'}>
        <ConversationPage
          sessionId={sessionId}
          onSessionLost={handleSessionLost}
          onNavigateFileChanges={goToFileChanges}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </KeepAlive>
      <KeepAlive mode={route.name === 'file-changes' ? 'visible' : 'hidden'}>
        <FileChangesPage
          sessionId={sessionId}
          onBack={goToConversation}
          theme={theme}
          onToggleTheme={toggleTheme}
          onSessionLost={handleSessionLost}
        />
      </KeepAlive>
    </SessionSocketProvider>
  );
}
