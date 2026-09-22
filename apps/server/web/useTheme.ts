import { useCallback, useEffect, useState } from 'react';
import { readStoredTheme, storeTheme } from './storage.js';

export type Theme = 'light' | 'dark';

/**
 * The chosen theme and the call that flips it.
 *
 * Held above the screens rather than inside one of them, because both carry the
 * toggle: kept in the conversation, the file list would either have no switch or a
 * second one with its own idea of which theme is on.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = useCallback((): void => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      storeTheme(next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
