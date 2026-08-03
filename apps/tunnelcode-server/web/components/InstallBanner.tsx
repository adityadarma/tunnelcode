import { useEffect, useState } from 'react';
import { notificationsSupported, notificationState } from '../notifications.js';
import { serviceWorkerSupported } from '../service-worker.js';

const DISMISSED_KEY = 'tunnelcode.installBannerDismissed';

/**
 * Whether the browser has offered to install the app, which is the signal that
 * the manifest was accepted and the service worker is in place.
 */
let deferredPrompt: BeforeInstallPromptEvent | undefined;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
}

function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

function wasDismissed(): boolean {
  return window.localStorage.getItem(DISMISSED_KEY) === '1';
}

function dismiss(): void {
  window.localStorage.setItem(DISMISSED_KEY, '1');
}

/**
 * A one-time hint that the app can be installed and notifications enabled.
 *
 * Shown after pairing, only when the browser has not already installed the app and
 * the user has not dismissed it before. Disappears on its own once dismissed, and
 * never shows again. See ADR-045.
 */
export function InstallBanner(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isInstalled() || wasDismissed()) {
      return;
    }

    // Give the page a moment to settle before showing the banner, so it does not
    // compete with the first render of a conversation.
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  if (!visible) {
    return null;
  }

  const canInstall = serviceWorkerSupported() && deferredPrompt !== undefined;
  const canNotify = notificationsSupported() && notificationState() !== 'granted';

  // Nothing to offer.
  if (!canInstall && !canNotify) {
    dismiss();
    return null;
  }

  const handleInstall = async (): Promise<void> => {
    if (deferredPrompt === undefined) {
      return;
    }

    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = undefined;
    dismiss();
    setVisible(false);
  };

  const handleDismiss = (): void => {
    dismiss();
    setVisible(false);
  };

  return (
    <div className="install-banner">
      <div className="install-banner-content">
        {canInstall && (
          <p>
            <strong>Install TunnelCode</strong> for a full-screen app experience without browser
            chrome.
          </p>
        )}
        {canNotify && (
          <p>
            Enable <strong>Notify me</strong> in the sidebar to be alerted when the agent needs
            approval or finishes answering.
          </p>
        )}
      </div>
      <div className="install-banner-actions">
        {canInstall && (
          <button
            type="button"
            className="btn-install"
            onClick={() => {
              void handleInstall();
            }}
          >
            Install
          </button>
        )}
        <button type="button" className="btn-dismiss" onClick={handleDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
