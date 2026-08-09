const SESSION_KEY = 'tunnelcode.sessionId';

/**
 * Remembers which session this browser was looking at, so a refresh returns to the
 * conversation instead of asking for a new pairing.
 *
 * An address, not a credential. Proving the session is the cookie's job, and the
 * cookie is not readable here on purpose: nothing kept in this file opens anything.
 * See ADR-041.
 */
export function readStoredSession(): string | undefined {
  const value = window.localStorage.getItem(SESSION_KEY);
  return value === null || value === '' ? undefined : value;
}

export function storeSession(sessionId: string): void {
  window.localStorage.setItem(SESSION_KEY, sessionId);
}

export function clearStoredSession(): void {
  window.localStorage.removeItem(SESSION_KEY);
}

const ACTIVE_CONVERSATION_KEY = 'tunnelcode.activeConversationId';
const SELECTED_MODEL_KEY = 'tunnelcode.selectedModel';

export function readStoredActiveConversationId(): string | undefined {
  const value = window.localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  return value === null || value === '' ? undefined : value;
}

export function storeActiveConversationId(conversationId: string): void {
  window.localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
}

export function clearStoredActiveConversationId(): void {
  window.localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
}

export function readStoredModel(): string | undefined {
  const value = window.localStorage.getItem(SELECTED_MODEL_KEY);
  return value === null || value === '' ? undefined : value;
}

export function storeModel(model: string): void {
  window.localStorage.setItem(SELECTED_MODEL_KEY, model);
}

const THEME_KEY = 'tunnelcode.theme';

export function readStoredTheme(): 'light' | 'dark' | undefined {
  const value = window.localStorage.getItem(THEME_KEY);
  return value === 'light' || value === 'dark' ? value : undefined;
}

export function storeTheme(theme: 'light' | 'dark'): void {
  window.localStorage.setItem(THEME_KEY, theme);
}

/**
 * Reads the pairing code from the QR URL and removes it from the address bar,
 * so the code does not linger in browser history.
 */
export function takeCodeFromUrl(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (code === null || code === '') {
    return undefined;
  }

  window.history.replaceState({}, '', window.location.pathname);

  // Returned as received: matching is case sensitive, so normalising here would
  // let a wrong-case code pair.
  return code;
}
