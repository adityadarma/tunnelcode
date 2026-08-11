import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionPickerModal } from './SessionPickerModal.js';

/**
 * Answers the listing request with one body, so each test can fix the machine's
 * answer and look at what the modal made of it.
 */
function stubListing(body: unknown): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function renderPicker(): void {
  render(
    <SessionPickerModal
      sessionId="session-1"
      engine="cursor"
      engineLabel="Cursor"
      online={true}
      onImport={() => undefined}
      onClose={() => undefined}
    />,
  );
}

describe('SessionPickerModal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('an unsupported engine shows the reason it sent, with no retry', async () => {
    const reason =
      'Cursor sessions cannot be read yet, so there is nothing here to import. Start a new conversation instead.';
    stubListing({ sessions: [], supported: false, reason });

    renderPicker();

    expect(await screen.findByText(reason)).toBeTruthy();
    // The scan will never work, so offering another go would waste the tap, and
    // "Cancel" would suggest there was an import in progress to abandon.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  test('a supported engine with nothing stored still reads as empty', async () => {
    stubListing({ sessions: [], supported: true });

    renderPicker();

    expect(await screen.findByText('No agent sessions found for Cursor.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  test('sessions render as cards in the order they arrived', async () => {
    stubListing({
      supported: true,
      sessions: [
        {
          id: 'a',
          title: 'Fix the parser',
          lastActiveAt: new Date().toISOString(),
          messageCount: 4,
          preview: 'done',
        },
        {
          id: 'b',
          title: 'Add a route',
          lastActiveAt: new Date().toISOString(),
          messageCount: 1,
          preview: '',
        },
      ],
    });

    renderPicker();

    expect(await screen.findByText('Fix the parser')).toBeTruthy();
    expect(screen.getByText('Add a route')).toBeTruthy();
    expect(screen.getByText('1 message')).toBeTruthy();
  });
});
