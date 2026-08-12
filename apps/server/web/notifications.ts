import { deletePushSubscription, readPushKey, savePushSubscription } from './api.js';
import { ensureServiceWorker, serviceWorkerSupported } from './service-worker.js';

/**
 * Notifications, in the two forms this app needs them.
 *
 * A page that is open raises its own the moment the socket reports something, whether
 * or not the user is looking at it. The server also pushes every one of them, and the
 * service worker shows that, which is what covers a page that is closed, asleep, or
 * frozen by the browser. The two collapse onto one notification per conversation, and
 * only the first of them alerts. See ADR-045 and ADR-054.
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
  /** Narrowed from the `any` the DOM types give it, since only one thing is put here. */
  data?: { key: string };
}

/**
 * Notifications this page raised itself, keyed by the event they are about.
 *
 * A notification made with the constructor is not part of the service worker's
 * registration, so it cannot be found again by tag: the only way to close one is to
 * keep hold of it. That matters for an ask, which stays on screen until it is dealt
 * with and has to go when it is answered somewhere else. See ADR-054.
 */
const raisedHere = new Map<string, Notification>();

/**
 * The event a notification is about, when it carries one.
 *
 * `data` is `any` in the DOM types and arbitrary in principle, so it is read through
 * a shape of its own rather than trusted: this one may have been raised by a push, by
 * this page, or by a version of the app that put nothing there.
 */
function keyOf(notification: Notification): string | undefined {
  const { data } = notification as { data?: { key?: unknown } };

  return typeof data?.key === 'string' ? data.key : undefined;
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
 * Raises a notification from the page itself.
 *
 * Returns false when the browser has no page notifications, which is the case on
 * Android: the constructor is there and throws when it is called. Reported rather
 * than raised, because the caller has a service worker to fall back to.
 */
function raiseHere(
  title: string,
  options: AlertingNotificationOptions,
  key: string | undefined,
): boolean {
  try {
    const notification = new Notification(title, options);

    if (key !== undefined) {
      raisedHere.set(key, notification);
      notification.addEventListener('close', () => {
        raisedHere.delete(key);
      });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Tells the service worker this page has announced an event.
 *
 * The server pushes every notification now, so the same event arrives twice on a
 * device whose page is alive. The worker collapses the two onto one notification by
 * tag either way; this is what stops the second one alerting again. See ADR-054.
 */
async function announce(key: string | undefined): Promise<void> {
  if (key === undefined) {
    return;
  }

  const registration = await ensureServiceWorker();
  const worker = registration?.active;

  if (worker !== undefined && worker !== null) {
    worker.postMessage({ type: 'announced', key });
  }
}

/**
 * Shows a notification from the page.
 *
 * Raised for every event, whatever the user happens to be looking at. Deciding
 * otherwise was the whole problem: the page was one of two places a notification
 * could come from, so it kept quiet whenever it judged the user to be watching, and
 * a browser that froze the tab meanwhile left nobody to raise it at all. A repeat of
 * something already on screen is a banner the user can ignore; an approval nobody
 * hears expires into a refusal. See ADR-054.
 */
async function show(
  title: string,
  body: string,
  tag: string,
  options: { key?: string; sticky?: boolean } = {},
): Promise<void> {
  if (notificationState() !== 'granted') {
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
    ...(options.key === undefined ? {} : { data: { key: options.key } }),
  };

  // Said before anything is shown, so the push for this event is already known to be
  // a duplicate by the time it arrives.
  void announce(options.key);

  // Which form to use is decided by visibility rather than by focus, because
  // visibility is what the browser itself keys on: Chrome suppresses
  // showNotification from a service worker while a tab on this origin is visible,
  // and a window sitting unfocused behind another application still counts as
  // visible. A page-level Notification works regardless, and is what the user proved
  // they wanted when they granted permission. The service worker path is kept for the
  // hidden case, where it is the only form Android accepts, and for a browser that
  // has no page notifications at all.
  if (!document.hidden && raiseHere(title, shared, options.key)) {
    return;
  }

  const registration = await ensureServiceWorker();

  if (registration !== undefined) {
    await registration.showNotification(title, { ...shared, badge: '/icon-192.png' });
    return;
  }

  raiseHere(title, shared, options.key);
}

/**
 * Takes down the notification for an ask that has been dealt with.
 *
 * An ask is shown with `requireInteraction`, so it sits there until something closes
 * it. Now that one is raised whatever the user is looking at, answering in the tab
 * would otherwise leave a banner still asking. Both places it can have come from are
 * closed: this page's own, and the worker's, which is looked up by tag and matched on
 * the ask so a later one is left alone.
 */
export function dismissPermission(permissionId: string, conversationId?: string): void {
  void dismiss(tagFor('permission', conversationId), permissionId);
}

async function dismiss(tag: string, key: string): Promise<void> {
  const raised = raisedHere.get(key);

  if (raised !== undefined) {
    raisedHere.delete(key);
    raised.close();
  }

  const registration = await ensureServiceWorker();

  if (registration === undefined) {
    return;
  }

  for (const notification of await registration.getNotifications({ tag })) {
    if (keyOf(notification) === key) {
      notification.close();
    }
  }
}

/** The agent has stopped and is waiting to be allowed to do something. */
export function notifyPermission(
  title: string,
  target: string | undefined,
  conversationId?: string,
  permissionId?: string,
): void {
  void show(
    'Approval needed',
    target === undefined ? title : `${title}: ${target}`,
    tagFor('permission', conversationId),
    { sticky: true, ...(permissionId === undefined ? {} : { key: permissionId }) },
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
  activityId?: string,
): void {
  void show('Tool call refused', `${tool}: ${reason}`, tagFor('blocked', conversationId), {
    sticky: true,
    ...(activityId === undefined ? {} : { key: activityId }),
  });
}

/** The turn is over, one way or another. */
export function notifyTurnDone(body: string, conversationId?: string, turnId?: string): void {
  void show('The answer is ready', body, tagFor('turn', conversationId), {
    ...(turnId === undefined ? {} : { key: turnId }),
  });
}
