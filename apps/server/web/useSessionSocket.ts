import { useCallback, useEffect, useRef, useState } from 'react';

/** Delay before reconnecting, so a dropped socket does not spin. */
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 30000;

/** One changed file in the workspace, as the device reported it. */
export interface FileChange {
  path: string;
  status: string;
  diff?: string;
}

/** Reads the changed files off a `file_changes` event, ignoring malformed entries. */
function readFileChanges(raw: unknown): FileChange[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const files: FileChange[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const candidate = entry as { path?: unknown; status?: unknown; diff?: unknown };

    if (typeof candidate.path !== 'string' || typeof candidate.status !== 'string') {
      continue;
    }

    files.push({
      path: candidate.path,
      status: candidate.status,
      ...(typeof candidate.diff === 'string' ? { diff: candidate.diff } : {}),
    });
  }

  // Sorted here rather than where they are drawn, because every reader wants the
  // same order and the list only changes when one of these events arrives.
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

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
   * The workspace's changed files, as the device last reported them.
   *
   * Held on the socket rather than in the screen that draws them, because the
   * socket is what receives them and it outlives that screen: leaving the file list
   * and coming back must not need a reconnect to find out what changed.
   */
  fileChanges: FileChange[];
  /**
   * Registers a listener for everything arriving on the socket and returns the call
   * that removes it again.
   *
   * More than one screen reads this stream, so the connection cannot belong to any
   * single one of them: a second socket would mean a second attach, and every event
   * delivered twice.
   */
  subscribe: (handler: (message: unknown) => void) => () => void;
  /**
   * Asks the server to describe the session again over the connection already open.
   *
   * Attaching is what reports a running turn and replays a waiting ask, so a screen
   * that stopped listening while it was off view catches up with this instead of
   * dropping the socket to earn a fresh one.
   */
  reattach: () => void;
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
   * Grants Antigravity write access to the workspace and retries the last prompt.
   *
   * Writes are the only thing grantable from here. See ADR-031.
   */
  sendGrantAndRetry: (conversationId: string) => void;
  /**
   * Asks for the running answer to stop.
   *
   * The turn is named so a tap arriving just after one answer ended cannot end the
   * next one. See ADR-042.
   */
  stopTurn: (turnId: string) => void;
  /**
   * Turns autopilot on or off for one conversation.
   *
   * Sent to the server rather than kept here, because the case it exists for is a
   * browser that is closed: an ask raised with nothing attached has to be answered by
   * something still running. See ADR-059.
   */
  setAutopilot: (conversationId: string, enabled: boolean) => void;
  disconnect: () => void;
}

interface UseSessionSocketOptions {
  sessionId: string;
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
 *
 * Mounted once above the screens rather than inside one of them, so moving between
 * them neither drops the connection nor opens a second one.
 */
export function useSessionSocket({ sessionId }: UseSessionSocketOptions): SessionSocket {
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(false);
  const [resumeApprovalNumber, setResumeApprovalNumber] = useState<string | undefined>(undefined);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);

  /**
   * The screens listening, held in a ref because the socket handler is built once
   * and must not depend on which of them happened to be mounted at the time.
   */
  const handlersRef = useRef<Set<(message: unknown) => void>>(new Set());

  const subscribe = useCallback((handler: (message: unknown) => void): (() => void) => {
    handlersRef.current.add(handler);

    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const sendAttach = useCallback((): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'attach', sessionId }));
  }, [sessionId]);

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

          if (type === 'file_changes' && 'files' in parsed) {
            const files = readFileChanges(parsed.files);

            if (files !== undefined) {
              setFileChanges(files);
            }
          }
        }

        // Iterated over a copy: a listener that unsubscribes on the event it just
        // received would otherwise change the set being walked.
        for (const handler of [...handlersRef.current]) {
          handler(parsed);
        }
      });

      socket.addEventListener('close', () => {
        setConnected(false);
        setOnline(false);
        // The number belonged to a request on that connection. Keeping it would show
        // a number the terminal is no longer asking about; the reconnect asks again.
        setResumeApprovalNumber(undefined);

        // The changed files are deliberately kept. They describe the workspace, not
        // the connection, and the server replays them on attach, so clearing them
        // would blank the list for the length of a reconnect and then fill it with
        // the same thing.

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

  const sendGrantAndRetry = useCallback((conversationId: string): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'grant_and_retry', conversationId, grant: 'writes' }));
  }, []);

  const stopTurn = useCallback((turnId: string): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'stop_turn', turnId }));
  }, []);

  const setAutopilot = useCallback((conversationId: string, enabled: boolean): void => {
    const socket = socketRef.current;

    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({ type: 'set_autopilot', conversationId, enabled }));
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
    fileChanges,
    subscribe,
    reattach: sendAttach,
    sendPrompt,
    sendPermissionResponse,
    sendGrantAndRetry,
    stopTurn,
    setAutopilot,
    disconnect,
  };
}
