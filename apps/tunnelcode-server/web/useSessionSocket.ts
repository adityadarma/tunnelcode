import { useCallback, useEffect, useRef, useState } from 'react';

/** Delay before reconnecting, so a dropped socket does not spin. */
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 30000;

export interface SessionSocket {
  online: boolean;
  connected: boolean;
  /**
   * The number the terminal has to approve before this session can be used again,
   * or undefined when nothing is waiting.
   *
   * Set when the CLI has restarted since this session was approved: the machine is
   * reachable, the session is real, and the person at the keyboard has not yet said
   * this browser may carry on. See ADR-040.
   */
  resumeApprovalNumber: string | undefined;
  /**
   * Sends a prompt. The engine and the model are not passed: they belong to the
   * conversation and the server reads them from it. See ADR-020.
   */
  sendPrompt: (conversationId: string, text: string) => void;
  /**
   * Answers a tool call the agent is waiting on.
   *
   * The conversation travels with it: the server refuses an answer aimed at an ask
   * this session does not own. See ADR-022.
   */
  sendPermissionResponse: (
    conversationId: string,
    permissionId: string,
    decision: 'once' | 'always' | 'reject',
  ) => void;
  /**
   * Grants the permission Antigravity was refused and retries the last prompt.
   *
   * The grant kind says what to allow: 'writes' or 'commands'.
   */
  sendGrantAndRetry: (conversationId: string, grant: 'writes' | 'commands') => void;
  /**
   * Asks for the running answer to stop.
   *
   * The turn is named so a tap arriving just after one answer ended cannot end the
   * next one. See ADR-042.
   */
  stopTurn: (turnId: string) => void;
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
  const [resumeApprovalNumber, setResumeApprovalNumber] = useState<string | undefined>(undefined);
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

          // Nothing was attached, so the session is on hold until the terminal
          // answers. Held here rather than passed on as an event, because it decides
          // what the whole screen shows.
          if (type === 'resume_pending' && 'approvalNumber' in parsed) {
            setResumeApprovalNumber(String(parsed.approvalNumber));
          }

          // Approved. Attaching again is what reports a running turn and replays a
          // waiting ask, so the resumed session lands in exactly the state a fresh
          // one does.
          if (type === 'resume_approved') {
            setResumeApprovalNumber(undefined);
            socket.send(JSON.stringify({ type: 'attach', sessionId }));
          }

          if (type === 'attached') {
            setResumeApprovalNumber(undefined);
          }
        }

        handlerRef.current(parsed);
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        setOnline(false);
        // The number belonged to a request on that connection. Keeping it would show
        // a number the terminal is no longer asking about; the reconnect asks again.
        setResumeApprovalNumber(undefined);

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

  const sendPrompt = useCallback((conversationId: string, text: string): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'prompt', conversationId, text }));
  }, []);

  const sendPermissionResponse = useCallback(
    (
      conversationId: string,
      permissionId: string,
      decision: 'once' | 'always' | 'reject',
    ): void => {
      const socket = socketRef.current;

      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(
        JSON.stringify({ type: 'permission_response', conversationId, permissionId, decision }),
      );
    },
    [],
  );

  const sendGrantAndRetry = useCallback(
    (conversationId: string, grant: 'writes' | 'commands'): void => {
      const socket = socketRef.current;

      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(JSON.stringify({ type: 'grant_and_retry', conversationId, grant }));
    },
    [],
  );

  const stopTurn = useCallback((turnId: string): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'stop_turn', turnId }));
  }, []);

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

  return {
    online,
    connected,
    resumeApprovalNumber,
    sendPrompt,
    sendPermissionResponse,
    sendGrantAndRetry,
    stopTurn,
    disconnect,
  };
}
