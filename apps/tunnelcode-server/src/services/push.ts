import type { PushRepository, StoredSubscription } from '../db/push-repository.js';
import type { BrowserRegistry } from '../ws/browser-registry.js';
import {
  encryptPushPayload,
  generateVapidKeys,
  vapidAuthorization,
  type VapidKeys,
} from './web-push.js';

/**
 * How long a push service should hold a message for a device that is asleep.
 *
 * Ten minutes, which is roughly how long an approval is worth asking about: a
 * notification delivered long after the ask expired would send the user to a screen
 * with nothing on it. See ADR-045.
 */
const TTL_SECONDS = 10 * 60;

/** Longest body a notification carries, so a payload stays well inside the 4 KB limit. */
const BODY_MAX_LENGTH = 180;

/**
 * The `sub` claim RFC 8292 asks a sender to state.
 *
 * A contact for whoever runs the server, which a push service may use to complain
 * about a badly behaved sender and never uses otherwise. It is not configurable: a
 * self hosted deployment has no address worth publishing to Google or Mozilla, and a
 * setting nobody has a reason to change is a setting to explain for nothing. The
 * claim itself cannot be dropped, because a push service refuses a token without one.
 */
const SUBJECT = 'mailto:tunnelcode@localhost';

/** What a notification is about, which is also what decides how it is presented. */
export type NotificationKind = 'permission' | 'done' | 'failed' | 'blocked';

export interface Notification {
  kind: NotificationKind;
  title: string;
  body: string;
  /** So a tap can open the conversation the notification came from. */
  conversationId?: string;
}

export interface PushServiceOptions {
  repository: PushRepository;
  /**
   * Read to find out whether anybody is watching.
   *
   * A browser holding the socket open shows the ask and the finished answer on the
   * page itself, so a notification would be telling the user something already in
   * front of them. Nothing connected is the case this exists for. See ADR-045.
   */
  browsers: BrowserRegistry;
  /** Failures are logged rather than raised: a turn must not depend on a push service. */
  log: (message: string, error?: unknown) => void;
}

/**
 * Sends notifications to browsers that are not connected.
 *
 * The signing identity is generated on first use and then read from the database,
 * so subscriptions stay valid across restarts. Everything here is fire and forget:
 * the agent's work is what matters, and a push service that is slow or down must
 * never hold up a turn.
 */
export class PushService {
  private keys: VapidKeys | undefined;

  constructor(private readonly options: PushServiceOptions) {}

  /** The application server key a browser subscribes with. */
  publicKey(): string {
    return this.signingKeys().publicKey;
  }

  /**
   * The signing identity, generating and persisting one the first time.
   *
   * Read back after writing rather than trusting the write, so two callers arriving
   * at once cannot end up signing with different keys.
   */
  private signingKeys(): VapidKeys {
    if (this.keys !== undefined) {
      return this.keys;
    }

    const stored = this.options.repository.findKeys();

    if (stored !== undefined) {
      this.keys = stored;
      return stored;
    }

    this.options.repository.saveKeys(generateVapidKeys());
    const written = this.options.repository.findKeys();

    if (written === undefined) {
      throw new Error('Cannot store the push signing key.');
    }

    this.keys = written;
    return written;
  }

  subscribe(sessionId: string, subscription: StoredSubscription): void {
    this.options.repository.save({ sessionId, ...subscription });
  }

  /** Gives up a subscription. Only the session that filed it can. */
  unsubscribe(sessionId: string, endpoint: string): void {
    this.options.repository.removeForSession(endpoint, sessionId);
  }

  /**
   * Drops everything filed against a session that has been retired.
   *
   * Nothing will happen on it again, so there is nothing left to notify about, and a
   * browser that pairs again subscribes for the session it gets then.
   */
  forgetSession(sessionId: string): void {
    this.options.repository.removeBySession(sessionId);
  }

  /**
   * Notifies a session, unless a browser is already watching it.
   *
   * Returns without waiting. Delivery is a background matter and a caller in the
   * middle of a turn has nothing useful to do with the outcome.
   */
  notify(sessionId: string, notification: Notification): void {
    if (this.options.browsers.has(sessionId)) {
      return;
    }

    const subscriptions = this.options.repository.listBySession(sessionId);

    if (subscriptions.length === 0) {
      return;
    }

    const payload = JSON.stringify({
      kind: notification.kind,
      title: notification.title,
      body: truncate(notification.body),
      ...(notification.conversationId === undefined
        ? {}
        : { conversationId: notification.conversationId }),
    });

    for (const subscription of subscriptions) {
      void this.send(subscription, payload, notification.kind);
    }
  }

  private async send(
    subscription: StoredSubscription,
    payload: string,
    kind: NotificationKind,
  ): Promise<void> {
    let endpointUrl: URL;

    try {
      endpointUrl = new URL(subscription.endpoint);
    } catch {
      // Stored before the schema refused anything but a URL, or corrupted since.
      this.options.repository.remove(subscription.endpoint);
      return;
    }

    try {
      const body = encryptPushPayload({ subscription, payload });
      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization({
            keys: this.signingKeys(),
            audience: endpointUrl.origin,
            subject: SUBJECT,
          }),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(TTL_SECONDS),
          // An approval is holding the agent still, so it is worth waking a sleeping
          // phone for. A blocked call stops the agent in the same way. A finished
          // answer is not urgent.
          urgency: kind === 'permission' || kind === 'blocked' ? 'high' : 'normal',
        },
        body,
      });

      // The subscription is gone: the browser was uninstalled, or its permission was
      // withdrawn. Keeping the row would only mean failing again on every turn.
      if (response.status === 404 || response.status === 410) {
        this.options.repository.remove(subscription.endpoint);
        return;
      }

      if (!response.ok) {
        this.options.log(`Push service refused a notification with ${String(response.status)}.`);
      }
    } catch (error) {
      this.options.log('Cannot reach the push service.', error);
    }
  }
}

/** Keeps a body short enough to be read on a lock screen, and to fit in a payload. */
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_MAX_LENGTH ? flat : `${flat.slice(0, BODY_MAX_LENGTH - 1)}…`;
}
