import { useCallback, useEffect, useRef, useState } from 'react';

/** Delay before reconnecting, so a dropped socket does not spin. */
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 30000;

export interface SessionSocket {
  online: boolean;
  connected: boolean;
  sendPrompt: (conversationId: string, text: string, model: string | undefined) => void;
  disconnect: () => void;
}

interface UseSessionSocketOptions {
  sessionId: string;
  onMessage: (message: unknown) => void;
}

function buildSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/browser`;
}

/**
 * Keeps a WebSocket open for the session and reconnects when it drops.
 *
 * Reconnecting re-attaches rather than re-pairing, because the session already
 * exists; a refresh must not ask the user to approve again.
 */
export function useSessionSocket({ sessionId, onMessage }: UseSessionSocketOptions): SessionSocket {
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(false);
  const handlerRef = useRef(onMessage);

  handlerRef.current = onMessage;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = (): void => {
      const socket = new WebSocket(buildSocketUrl());
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: 'attach', sessionId }));
        pingTimer = window.setInterval(() => {
          socket.send(JSON.stringify({ type: 'ping' }));
        }, PING_INTERVAL_MS);
      });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
          const { type } = parsed;

          if ((type === 'attached' || type === 'device_status') && 'online' in parsed) {
            setOnline(parsed.online === true);
          }
        }

        handlerRef.current(parsed);
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        setOnline(false);

        if (pingTimer !== undefined) {
          window.clearInterval(pingTimer);
          pingTimer = undefined;
        }

        if (!disposed) {
          reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
        }
      });
    };

    connect();

    return () => {
      disposed = true;

      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      if (pingTimer !== undefined) {
        window.clearInterval(pingTimer);
      }

      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [sessionId]);

  const sendPrompt = useCallback(
    (conversationId: string, text: string, model: string | undefined): void => {
      const socket = socketRef.current;

      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'prompt',
          conversationId,
          text,
          ...(model !== undefined ? { model } : {}),
        }),
      );
    },
    [],
  );

  /**
   * Ends the session on the paired machine before the browser forgets it.
   *
   * The agent runs there, so clearing local state alone would leave a terminal
   * waiting for a browser that already left.
   */
  const disconnect = useCallback((): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'disconnect' }));
  }, []);

  return { online, connected, sendPrompt, disconnect };
}
