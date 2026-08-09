import type { WebSocket } from 'ws';

/**
 * How long a socket may stay open without identifying itself.
 *
 * Both sockets identify on their first message, so this only has to cover the
 * network and a cold start rather than anything a person does. Generous enough that
 * a slow link is never mistaken for a socket that is never going to say who it is.
 */
const AUTH_TIMEOUT_MS = 15_000;

/**
 * Closes a socket that never identifies itself.
 *
 * Until a CLI registers or a browser attaches, a connection has proved nothing and
 * costs a socket, a heartbeat, and whatever the transport buffers for it. Nothing
 * ended those: an unauthenticated socket could sit open until the server restarted,
 * so opening many of them was a way to spend the server's resources without
 * completing a single pairing.
 *
 * The timer is unreferenced so a pending one cannot hold the event loop open and
 * delay shutdown, which is what a socket that connects during a drain would do.
 *
 * Returns the function that disarms it, to be called once the socket has identified
 * itself and again when it closes. Calling it twice is harmless.
 */
export function startAuthTimeout(
  socket: WebSocket,
  onTimeout: () => void,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): () => void {
  let timer: NodeJS.Timeout | undefined = setTimeout(() => {
    timer = undefined;

    // Reported before closing, because a client that is told why can say so; one
    // that is dropped silently looks like a network fault.
    try {
      onTimeout();
    } catch {
      // A socket that has already gone is exactly the case this guards, and the
      // close below is what matters.
    }

    socket.close();
  }, timeoutMs);

  timer.unref();

  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
