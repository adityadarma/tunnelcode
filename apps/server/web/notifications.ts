import { deletePushSubscription, readPushKey, savePushSubscription } from './api.js';
import { ensureServiceWorker, serviceWorkerSupported } from './service-worker.js';

/**
 * Notifications, in the two forms this app needs them.
 *
 * While a page is open the socket already reports everything, so a notification is
 * only worth raising when the page is not the thing the user is looking at, and it
 * is raised here. While no page is open at all the server sends a push instead and
 * the service worker shows it, which is the case the subscription below exists for.
 * See ADR-045.
 */

/** What the user can be told, from the point of view of the button that offers it. */
export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

/**
 * Notification options plus `renotify`, which the DOM types leave out.
 *
 * It is part of the notification standard and is what every browser that honours
 * tags reads to decide whether a replacement alerts the user or arrives in silence.
 * TypeScript describes only the subset shared by the page and service worker forms.
 * Declared once here so the remaining options stay checked rather than cast away at
 * each call.
 */
interface AlertingNotificationOptions extends NotificationOptions {
  renotify?: boolean;
}

/**
 * A notification already on screen is replaced rather than stacked, scoped to the
 * conversation it came from.
 *
 * The same scoping the service worker uses for a push, so the two places that raise
 * a notification collapse onto the same one rather than showing two of it. Unscoped
 * tags meant a second conversation replaced the first one's notification, which read
 * as the first ask having been answered.
 */
function tagFor(kind: 'permission' | 'blocked' | 'turn', conversationId?: string): string {
  return conversationId === undefined ? kind : `${kind}-${conversationId}`;
}

export function notificationsSupported(): boolean {
  return serviceWorkerSupported() && 'Notification' in window && 'PushManager' in window;
}

export function notificationState(): NotificationState {
  if (!notificationsSupported()) {
    return 'unsupported';
  }

  const permission = Notification.permission;

  return permission === 'granted' || permission === 'denied' ? permission : 'default';
}

/** The subscription this browser already has, if any. */
async function currentSubscription(): Promise<PushSubscription | undefined> {
  const registration = await ensureServiceWorker();

  if (registration === undefined) {
    return undefined;
  }

  return (await registration.pushManager.getSubscription()) ?? undefined;
}

/**
 * A base64url key as the subscribe call wants it.
 *
 * `applicationServerKey` takes bytes, and the server states its key the way every
 * other implementation does, as base64url text.
 */
function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

/**
 * Whether a subscription was made against the key the server signs with now.
 *
 * A subscription is bound to one application server key: if the deployment states a
 * different one, the push service refuses every message sent to this endpoint, and
 * nothing in the browser says so. Reusing it would leave notifications switched on and
 * silent. See ADR-045.
 */
function matchesKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const applied = subscription.options.applicationServerKey;

  if (applied === null) {
    return false;
  }

  const bytes = new Uint8Array(applied);

  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

/**
 * The subscription for the current key, replacing one made against an older key.
 *
 * The server is told to forget the endpoint being replaced, since a new subscription
 * gets a new endpoint and the old row would otherwise sit there until the session
 * ends. That is tidying rather than something to fail over, so it is allowed to fail.
 */
async function ensureSubscription(
  registration: ServiceWorkerRegistration,
  key: Uint8Array<ArrayBuffer>,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription();

  if (existing !== null) {
    if (matchesKey(existing, key)) {
      return existing;
    }

    try {
      await deletePushSubscription(existing.endpoint);
    } catch {
      // The row may belong to a session that has already ended, which is nothing to
      // report: the point was to stop sending to it, and nobody is.
    }

    await existing.unsubscribe();
  }

  return registration.pushManager.subscribe({
    // Every browser requires this, and a payload nobody can read would be a
    // notification with nothing in it.
    userVisibleOnly: true,
    applicationServerKey: key,
  });
}

/** The subscription in the shape the server stores, or undefined if it is incomplete. */
function describe(
  subscription: PushSubscription,
): { endpoint: string; p256dh: string; auth: string } | undefined {
  const json = subscription.toJSON();
  const p256dh = json.keys?.['p256dh'];
  const auth = json.keys?.['auth'];

  if (json.endpoint === undefined || p256dh === undefined || auth === undefined) {
    return undefined;
  }

  return { endpoint: json.endpoint, p256dh, auth };
}

/**
 * Asks for permission, subscribes, and tells the server where to send.
 *
 * Has to be called from something the user pressed: browsers refuse the permission
 * prompt otherwise, and iOS refuses it entirely until the app has been added to the
 * home screen. Returns the state the button should now show, so a refusal is
 * reported rather than thrown.
 */
export async function enableNotifications(): Promise<NotificationState> {
  if (!notificationsSupported()) {
    return 'unsupported';
  }

  const permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    return permission === 'denied' ? 'denied' : 'default';
  }

  const registration = await ensureServiceWorker();

  if (registration === undefined) {
    return 'unsupported';
  }

  const subscription = await ensureSubscription(registration, decodeKey(await readPushKey()));
  const described = describe(subscription);

  if (described === undefined) {
    return 'default';
  }

  await savePushSubscription({
    endpoint: described.endpoint,
    keys: { p256dh: described.p256dh, auth: described.auth },
  });

  return 'granted';
}

/**
 * Stops notifications.
 *
 * The server is told first, because dropping the local subscription would leave it
 * with an endpoint it can no longer be asked to forget.
 */
export async function disableNotifications(): Promise<void> {
  const subscription = await currentSubscription();

  if (subscription === undefined) {
    return;
  }

  await deletePushSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}

/** Whether the server currently has somewhere to send to for this browser. */
export async function notificationsActive(): Promise<boolean> {
  return notificationState() === 'granted' && (await currentSubscription()) !== undefined;
}

/**
 * Renews the subscription the server holds.
 *
 * Called when a session starts, because a subscription is filed against the session
 * that made it: pairing again would otherwise leave a browser that had already said
 * yes with notifications nobody sends. This is also where a deployment that has
 * changed its signing key is noticed, since the old subscription is replaced rather
 * than reported.
 *
 * Silent by design, and never asks for permission: a browser that has not agreed to
 * notifications is left alone, and one that has is not made to press the button again.
 */
export async function refreshSubscription(): Promise<void> {
  if (notificationState() !== 'granted') {
    return;
  }

  const registration = await ensureServiceWorker();

  // Nothing to renew for a browser that never subscribed here. Subscribing now would
  // be turning notifications on for somebody who did not ask.
  if (registration === undefined || (await currentSubscription()) === undefined) {
    return;
  }

  const described = describe(
    await ensureSubscription(registration, decodeKey(await readPushKey())),
  );

  if (described === undefined) {
    return;
  }

  await savePushSubscription({
    endpoint: described.endpoint,
    keys: { p256dh: described.p256dh, auth: described.auth },
  });
}

/**
 * Whether the user is actually looking at this page.
 *
 * Visibility alone is not enough. A tab that is the front tab of its window is
 * `visible` even while the window is behind another application or another browser
 * window, so a user who switched to their terminal was treated as watching and told
 * nothing. Focus is what separates the two, and both have to hold for the page to be
 * what is in front of the user.
 *
 * The cost of reading it this way is a notification for a page that is on a second
 * screen the user can see but is not typing into. That is the right side to err on:
 * an unseen approval expires into a refusal, while a notification for something
 * already on screen is a banner that repeats it.
 */
function watching(): boolean {
  return !document.hidden && document.hasFocus();
}

/**
 * Shows a notification from the page.
 *
 * Raised when the user is not looking at the event: the page is not in front of them,
 * or the event belongs to a conversation that is not on screen. A focused page showing
 * the exact conversation raises nothing, because the answer or the ask is already
 * there. Shown through the service worker rather than as a page notification, because
 * that is the form Android requires.
 */
async function show(
  title: string,
  body: string,
  tag: string,
  options: { force?: boolean; sticky?: boolean } = {},
): Promise<void> {
  if (notificationState() !== 'granted') {
    return;
  }

  // Skip only when the page is in front of the user AND the caller did not say to
  // force it (meaning the event is for the conversation on screen).
  if (watching() && options.force !== true) {
    return;
  }

  // Replacing a notification that carries the same tag is silent by default: no
  // sound, no banner, nothing the user in another tab would notice. A session that
  // asks twice would have raised the second ask into a notification nobody was
  // alerted to. `renotify` is what makes the replacement announce itself.
  //
  // `requireInteraction` keeps an ask on screen until it is dealt with, matching what
  // the service worker does for a push: an approval holds the agent still, so a
  // banner that hides itself after a few seconds is the whole notification missed.
  const shared: AlertingNotificationOptions = {
    body,
    tag,
    renotify: true,
    icon: '/icon-192.png',
    ...(options.sticky === true ? { requireInteraction: true } : {}),
  };

  // Which form to use is decided by visibility rather than by focus, because
  // visibility is what the browser itself keys on: Chrome suppresses
  // showNotification from a service worker while a tab on this origin is visible,
  // and a window sitting unfocused behind another application still counts as
  // visible. A page-level Notification works regardless, and is what the user proved
  // they wanted when they granted permission. The service worker path is kept for the
  // hidden case, where it is the only form Android accepts.
  if (!document.hidden) {
    new Notification(title, shared);
    return;
  }

  const registration = await ensureServiceWorker();

  if (registration !== undefined) {
    await registration.showNotification(title, { ...shared, badge: '/icon-192.png' });
    return;
  }

  new Notification(title, shared);
}

/** The agent has stopped and is waiting to be allowed to do something. */
export function notifyPermission(
  title: string,
  target: string | undefined,
  conversationId?: string,
  otherConversation = false,
): void {
  void show(
    'Approval needed',
    target === undefined ? title : `${title}: ${target}`,
    tagFor('permission', conversationId),
    { force: otherConversation, sticky: true },
  );
}

/**
 * A tool call the engine was not allowed to make.
 *
 * The other half of an ask, for an engine that cannot raise one. Antigravity is
 * headless and decides alone, so the thing worth telling the user about arrives as a
 * refusal that has already happened rather than as a question. The server already
 * pushes it when no page is open; without this, a hidden tab was the one place it was
 * reported nowhere at all, because being attached is what stops the push. See
 * ADR-031 and ADR-045.
 *
 * Sticky for the same reason the service worker makes it sticky: the refusal ended
 * that piece of work, and it takes a grant to get past it.
 */
export function notifyBlocked(
  tool: string,
  reason: string,
  conversationId?: string,
  otherConversation = false,
): void {
  void show('Tool call refused', `${tool}: ${reason}`, tagFor('blocked', conversationId), {
    force: otherConversation,
    sticky: true,
  });
}

/** The turn is over, one way or another. */
export function notifyTurnDone(
  body: string,
  conversationId?: string,
  otherConversation = false,
): void {
  void show('The answer is ready', body, tagFor('turn', conversationId), {
    force: otherConversation,
  });
}
