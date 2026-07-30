import { beforeEach, describe, expect, test } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoute } from './useRoute.js';

describe('useRoute', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  test('the root path is the pairing screen', () => {
    const { result } = renderHook(() => useRoute());

    expect(result.current.route.name).toBe('login');
  });

  test('a conversation url renders the conversation', () => {
    window.history.replaceState({}, '', '/conversation');

    const { result } = renderHook(() => useRoute());

    // A refresh must not drop the user back onto the pairing screen.
    expect(result.current.route.name).toBe('conversation');
  });

  test('navigating changes the url', () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      result.current.goToConversation();
    });

    expect(window.location.pathname).toBe('/conversation');
    expect(result.current.route.name).toBe('conversation');
  });

  test('going back returns to pairing', async () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      result.current.goToConversation();
    });

    // jsdom applies history.back() and fires popstate on a later tick, so the
    // hook has to be given time to react rather than being nudged manually.
    await act(async () => {
      window.history.back();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    });

    expect(window.location.pathname).toBe('/');
    expect(result.current.route.name).toBe('login');
  });

  test('a lost session leaves no conversation entry in history', () => {
    const { result } = renderHook(() => useRoute());

    act(() => {
      result.current.goToConversation();
    });
    act(() => {
      result.current.goToLogin();
    });

    expect(window.location.pathname).toBe('/');

    // replaceState means back cannot return to a conversation that will not load.
    act(() => {
      window.history.back();
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.route.name).toBe('login');
  });

  test('the navigation helpers keep a stable identity', () => {
    const { result, rerender } = renderHook(() => useRoute());
    const first = result.current.goToConversation;

    rerender();

    // Callers depend on these inside effects, so a new function each render would
    // cause an endless loop.
    expect(result.current.goToConversation).toBe(first);
  });
});
