import { createContext, useContext } from 'react';
import { useSessionSocket, type SessionSocket } from './useSessionSocket.js';

/**
 * The session's socket, shared by every screen behind pairing.
 *
 * Undefined means no provider is above, which is a mistake rather than a state to
 * handle: a screen that reads this cannot work without a connection.
 */
const SessionSocketContext = createContext<SessionSocket | undefined>(undefined);

interface SessionSocketProviderProps {
  sessionId: string;
  children: React.ReactNode;
}

/**
 * Opens the session's socket and hands it to everything below.
 *
 * Mounted above the screens because they outlast each other: the conversation and
 * the file list both read this stream, and giving either one the connection would
 * mean a second attach, every event delivered twice, and a reconnect on every move
 * between them.
 *
 * Keyed on the session so a new pairing gets a new connection rather than one still
 * attached to the session that was left.
 */
export function SessionSocketProvider({
  sessionId,
  children,
}: SessionSocketProviderProps): React.JSX.Element {
  const socket = useSessionSocket({ sessionId });

  return <SessionSocketContext.Provider value={socket}>{children}</SessionSocketContext.Provider>;
}

/** Reads the shared session socket. Throws when used outside the provider. */
export function useSharedSessionSocket(): SessionSocket {
  const socket = useContext(SessionSocketContext);

  if (socket === undefined) {
    throw new Error('useSharedSessionSocket used outside SessionSocketProvider.');
  }

  return socket;
}
