import type { WebSocket } from 'ws';

/**
 * How often a socket is probed. A peer that answers nothing for two intervals is
 * dropped, so a dead connection is noticed within about a minute. Idling is safe:
 * an answered probe is enough, the peer never has to send anything itself.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * Drops a CLI connection that stopped answering.
 *
 * A closed laptop or a changed network leaves a socket that never delivers a
 * close frame, so the server would keep believing the device is online. That
 * matters for pairing: a code is held by whoever registered it, and the holder
 * is only forgotten when its socket closes. Without this, a dead session keeps
 * its code and its workspace until the server restarts.
 *
 * Uses WebSocket ping frames rather than application messages, so it works even
 * when the CLI is busy and says nothing.
 */
export function startHeartbeat(socket: WebSocket): () => void {
  let awaitingPong = false;

  const timer = setInterval(() => {
    // Silence across a full interval after a ping means the peer is gone.
    // Terminating rather than closing skips the handshake a dead peer will never
    // complete, and still fires the close event the cleanup path depends on.
    if (awaitingPong) {
      socket.terminate();
      return;
    }

    awaitingPong = true;
    socket.ping();
  }, HEARTBEAT_INTERVAL_MS);

  // Any traffic proves the peer is alive, not just a matching pong.
  const alive = (): void => {
    awaitingPong = false;
  };

  socket.on('pong', alive);
  socket.on('message', alive);

  return () => {
    clearInterval(timer);
    socket.off('pong', alive);
    socket.off('message', alive);
  };
}
