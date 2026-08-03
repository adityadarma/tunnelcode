/**
 * Service worker for the web app.
 *
 * Two jobs, and deliberately no more. It keeps enough of the app cached that the
 * installed app opens without a network, and it turns a push message into a
 * notification, which is the only way the user hears about an approval while no
 * page is open. See ADR-045.
 *
 * Written by hand rather than generated, so what gets cached is something a reader
 * can check. Nothing from the API is ever cached: a transcript is state, and a
 * stale one presented as current would be a lie the page cannot detect.
 */

/** Bumped when the caching rules here change, which is what retires the old cache. */
const CACHE = 'tunnelcode-shell-v1';

/** The document, which is what a navigation falls back to when offline. */
const SHELL = '/';

/** Paths the server owns. A response from any of them is state, never a file. */
const API_PREFIXES = ['/pair', '/sessions', '/conversations', '/health', '/push', '/ws'];

/** Where the notification lands when tapped. */
const CONVERSATION_PATH = '/conversation';

self.addEventListener('install', (event) => {
  // The shell is the only thing precached. Everything else Vite emits carries a
  // content hash in its name, so it is cached the first time it is asked for and
  // never has to be invalidated.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(SHELL, { cache: 'reload' })))
      // A failed precache must not leave the worker uninstalled: the app works
      // online without it, and the next navigation fills the cache.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

function isApi(pathname) {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Serves a navigation.
 *
 * Network first, so a deployed change is picked up immediately and the cached copy
 * is only ever a fallback for having no connection. The alternative would show
 * yesterday's app to somebody who is online.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(CACHE);
    await cache.put(SHELL, response.clone());
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL);

    if (cached !== undefined) {
      return cached;
    }

    throw error;
  }
}

/**
 * Serves a built asset.
 *
 * Cache first, because the name of one of these already identifies its contents: a
 * changed file is a different URL, so a hit can never be stale.
 */
async function handleAsset(request) {
  const cached = await caches.match(request);

  if (cached !== undefined) {
    return cached;
  }

  const response = await fetch(request);

  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }

  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Another origin is not this app's to cache, and the API is state.
  if (url.origin !== self.location.origin || isApi(url.pathname)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

/** What the server said, or an empty object when it said nothing readable. */
function readPayload(data) {
  if (data === null) {
    return {};
  }

  try {
    return data.json();
  } catch {
    return {};
  }
}

/**
 * Turns a push message into a notification.
 *
 * The payload was encrypted for this browser, so nothing between here and the
 * server could read it. A message that arrives without one still gets a
 * notification: a push a browser does not show is a permission browsers withdraw.
 */
self.addEventListener('push', (event) => {
  const payload = readPayload(event.data);

  const title = typeof payload.title === 'string' ? payload.title : 'TunnelCode';
  const body = typeof payload.body === 'string' ? payload.body : 'The agent needs you.';
  const kind = payload.kind === 'permission' ? 'permission' : 'turn';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // One notification per kind per conversation, so a long session does not
      // stack up a screenful of them.
      tag: typeof payload.conversationId === 'string' ? `${kind}-${payload.conversationId}` : kind,
      // An approval holds the agent still until it is answered, so it stays on
      // screen. A finished answer does not need to be dismissed by hand.
      requireInteraction: kind === 'permission',
      data: { url: CONVERSATION_PATH },
    }),
  );
});

/**
 * Opens the app where the notification came from.
 *
 * An already open window is focused rather than a second one opened, since the
 * session lives in that window and two of them would both hold a socket.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const target = new URL(event.notification.data?.url ?? CONVERSATION_PATH, self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin) {
          await client.focus();
          return;
        }
      }

      await self.clients.openWindow(target.href);
    }),
  );
});
