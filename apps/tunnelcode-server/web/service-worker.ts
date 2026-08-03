/**
 * Registration of the service worker.
 *
 * Kept apart from what the app does with it: this file only answers whether there
 * is a worker and hands out the registration, so the pieces that need one do not
 * each have to know how it got there. See ADR-045.
 */

const SCRIPT_URL = '/sw.js';

/**
 * The registration, once. Held so a caller can await the same promise instead of
 * registering again, which the browser would treat as an update check.
 */
let registration: Promise<ServiceWorkerRegistration | undefined> | undefined;

/** Whether this browser can run one at all. */
export function serviceWorkerSupported(): boolean {
  return 'serviceWorker' in navigator;
}

/**
 * Registers the worker, or resolves undefined when it cannot be registered.
 *
 * Failing is normal rather than exceptional: a service worker needs a secure
 * context, so a server reached over plain http on anything but localhost has none,
 * and the app has to work exactly as it did before. Nothing here is awaited by the
 * render.
 */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!serviceWorkerSupported()) {
    return undefined;
  }

  registration ??= navigator.serviceWorker.register(SCRIPT_URL).then(
    (result) => result,
    () => undefined,
  );

  return registration;
}
