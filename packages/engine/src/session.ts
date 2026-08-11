/**
 * Lightweight summary of a local agent session for listing.
 *
 * Returned by an engine's listLocalSessions method so the browser can present
 * available sessions to continue from.
 */
export interface SessionSummary {
  /** Unique identifier for this session within the engine's local storage. */
  id: string;
  /** Derived from the first user message, truncated. */
  title: string;
  /** ISO 8601 timestamp of last activity in the session. */
  lastActiveAt: string;
  /** Number of user + assistant messages. */
  messageCount: number;
  /** Last assistant message content, truncated to 200 characters. */
  preview: string;
}

/**
 * A message as read from an agent's local session file.
 */
export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * A tool call as read from an agent's local session file.
 */
export interface SessionActivity {
  id: string;
  tool: string;
  target: string | null;
  output: string | null;
}

/**
 * Full content of an agent session, for import.
 *
 * Contains the messages, activities, and optionally the engine's native session
 * id for resuming the conversation where the agent left off.
 */
export interface SessionContent {
  /** The engine's session id for native resume. Null if not recoverable. */
  engineSessionId: string | null;
  messages: SessionMessage[];
  activities: SessionActivity[];
}

/**
 * Raised by listLocalSessions when the scan cannot run on this machine.
 *
 * An empty array is an answer: this engine was read and it holds no sessions.
 * That is a different fact from a scan that never happened because something
 * the read depends on is missing here, and reporting the second as the first
 * tells the user their history is gone when it is only out of reach. Callers
 * surface the message as the reason the engine is unsupported.
 */
export class SessionScanUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionScanUnsupportedError';
  }
}
