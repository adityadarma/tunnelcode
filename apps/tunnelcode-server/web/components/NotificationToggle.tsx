import { useEffect, useState } from 'react';
import {
  disableNotifications,
  enableNotifications,
  notificationState,
  notificationsActive,
  notificationsSupported,
} from '../notifications.js';
import type { NotificationState } from '../notifications.js';

/**
 * Turns notifications on and off.
 *
 * A button rather than something done on load, because a browser only offers the
 * permission prompt in response to a press, and because asking unprompted is how an
 * app gets refused permanently. Installed as an app on iOS this is the only route:
 * Safari will not even consider the request from a tab. See ADR-045.
 */
export function NotificationToggle(): React.JSX.Element | null {
  const [state, setState] = useState<NotificationState>(notificationState);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  // Permission alone does not mean the server has anywhere to send: the
  // subscription can be gone while the permission is still granted, and then the
  // button has to offer to make one again.
  useEffect(() => {
    void (async () => {
      setActive(await notificationsActive());
    })();
  }, [state]);

  if (!notificationsSupported()) {
    return null;
  }

  const toggle = (): void => {
    setBusy(true);

    void (async () => {
      try {
        if (active) {
          await disableNotifications();
          setActive(false);
          return;
        }

        const result = await enableNotifications();
        setState(result);
        // Set active immediately after a successful subscribe rather than waiting for
        // the effect to re-check. The effect races with the subscribe finishing, and a
        // slow getSubscription() made the button look stuck. See ADR-045.
        setActive(result === 'granted');
      } finally {
        setBusy(false);
      }
    })();
  };

  // Nothing this component does can undo a refusal: the browser owns that setting,
  // so it says where to change it rather than offering a button that cannot work.
  if (state === 'denied') {
    return (
      <p className="notify-blocked">
        Notifications are blocked for this site. Allow them in your browser settings to hear about
        approvals while this is closed.
      </p>
    );
  }

  return (
    <button
      type="button"
      className={active ? 'btn-notify on' : 'btn-notify'}
      onClick={toggle}
      disabled={busy}
      aria-pressed={active}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        {!active && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
      <span>{active ? 'Notifications on' : 'Notify me'}</span>
    </button>
  );
}
