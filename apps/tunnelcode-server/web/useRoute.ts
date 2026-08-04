import { useCallback, useEffect, useState } from 'react';

export type Route = { name: 'login' } | { name: 'conversation' } | { name: 'file-changes' };

const CONVERSATION_PATH = '/conversation';
const FILE_CHANGES_PATH = '/file-changes';

function routeFromPath(pathname: string): Route {
  if (pathname.startsWith(FILE_CHANGES_PATH)) return { name: 'file-changes' };
  if (pathname.startsWith(CONVERSATION_PATH)) return { name: 'conversation' };
  return { name: 'login' };
}

/**
 * Minimal history based routing.
 *
 * Pairing and the conversation get their own URL so the browser back button and a
 * refresh both behave: a refresh on /conversation reloads the conversation
 * instead of showing the pairing screen again.
 */
export function useRoute(): {
  route: Route;
  goToConversation: () => void;
  goToFileChanges: () => void;
  goToLogin: () => void;
} {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => {
      setRoute(routeFromPath(window.location.pathname));
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  // Stable identities, so callers can depend on them in an effect without
  // re-running it on every render.
  const goToConversation = useCallback((): void => {
    window.history.pushState({}, '', CONVERSATION_PATH);
    setRoute({ name: 'conversation' });
  }, []);

  // Replaces rather than pushes: a lost session must not leave a conversation
  // entry in history that can never load again.
  const goToLogin = useCallback((): void => {
    window.history.replaceState({}, '', '/');
    setRoute({ name: 'login' });
  }, []);

  const goToFileChanges = useCallback((): void => {
    window.history.pushState({}, '', FILE_CHANGES_PATH);
    setRoute({ name: 'file-changes' });
  }, []);

  return { route, goToConversation, goToFileChanges, goToLogin };
}
