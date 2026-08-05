import { useCallback, useEffect, useState } from 'react';

export type Route =
  { name: 'index' } | { name: 'login' } | { name: 'conversation' } | { name: 'file-changes' };

const CONVERSATION_PATH = '/conversation';
const FILE_CHANGES_PATH = '/file-changes';
const LOGIN_PATH = '/login';

function routeFromPath(pathname: string): Route {
  if (pathname.startsWith(FILE_CHANGES_PATH)) return { name: 'file-changes' };
  if (pathname.startsWith(CONVERSATION_PATH)) return { name: 'conversation' };
  if (pathname.startsWith(LOGIN_PATH) || pathname.startsWith('/pair')) return { name: 'login' };
  return { name: 'index' };
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
  goToLanding: () => void;
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

  const goToLanding = useCallback((): void => {
    window.history.pushState({}, '', '/');
    setRoute({ name: 'index' });
  }, []);

  const goToConversation = useCallback((): void => {
    window.history.pushState({}, '', CONVERSATION_PATH);
    setRoute({ name: 'conversation' });
  }, []);

  const goToLogin = useCallback((): void => {
    window.history.pushState({}, '', LOGIN_PATH);
    setRoute({ name: 'login' });
  }, []);

  const goToFileChanges = useCallback((): void => {
    window.history.pushState({}, '', FILE_CHANGES_PATH);
    setRoute({ name: 'file-changes' });
  }, []);

  return { route, goToLanding, goToConversation, goToFileChanges, goToLogin };
}
