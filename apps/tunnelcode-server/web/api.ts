export interface PairPendingResponse {
  status: 'pending';
  requestId: string;
  approvalNumber: string;
}

export interface PairStatusResponse {
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  sessionId?: string;
}

/** An engine the paired machine can run, with the models it reported. */
export interface DeviceEngine {
  name: string;
  models: string[];
}

export interface SessionDetail {
  id: string;
  deviceName: string;
  workspace: string;
  /** Engine a new conversation starts on, as named in the terminal. */
  engine: string;
  online: boolean;
  /**
   * Every engine installed on the machine. A conversation picks one when it is
   * created. Empty while the device is offline, since the list describes what the
   * running CLI can serve. See ADR-020.
   */
  engines: DeviceEngine[];
}

export interface ActivityOutput {
  type: 'activity_output';
  turnId: string;
  activityId: string;
  output: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  /**
   * Engine every prompt in this conversation runs through, fixed when it was
   * created. Null on a conversation from before conversations had one.
   */
  engine: string | null;
  /** Model asked for, or null to let the engine decide. */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * True when the turn failed partway and this is only what the engine managed to
   * say. Absent on a server that predates the flag, which is read as complete.
   */
  partial?: boolean;
  createdAt: number;
}

/**
 * Something the engine did during a turn, shown alongside the messages.
 *
 * The optional fields are `null` as well as absent, because the two ways an
 * activity reaches the browser disagree: a live `activity` frame omits what it
 * does not have, while the transcript endpoint returns the stored row, which
 * carries an explicit `null` for every empty column. Declaring only `string`
 * here is what let a `null` target reach `.split()` and blank the page.
 */
export interface Activity {
  id: string;
  tool: string;
  target?: string | null;
  /**
   * True when the engine was refused permission, so the call never happened.
   * Absent on a server that predates the flag, which is read as having run.
   */
  blocked?: boolean;
  /** Why the call was refused, present only on a blocked one. */
  reason?: string | null;
  /** Raw output of the tool, when the engine reported any. */
  output?: string | null;
  createdAt: number;
}

export interface Transcript {
  messages: Message[];
  activities: Activity[];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Header the session travels in on requests that name only a conversation.
 *
 * A conversation id is not a credential: the server checks that the session
 * sending this is entitled to the conversation before answering.
 */
const SESSION_HEADER = 'x-tunnelcode-session';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);

  // Only declared when something is actually sent. Announcing JSON on a bodyless
  // request makes the server reject it as an empty JSON body, which is how a
  // plain POST like creating a conversation would fail.
  if (init?.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, { ...init, headers });

  const text = await response.text();
  const parsed: unknown = text === '' ? {} : JSON.parse(text);

  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && 'error' in parsed
        ? String(parsed.error)
        : `Request failed with status ${String(response.status)}`;
    throw new ApiError(response.status, message);
  }

  return parsed as T;
}

export async function startPairing(code: string): Promise<PairPendingResponse> {
  return request<PairPendingResponse>('/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function readPairStatus(requestId: string): Promise<PairStatusResponse> {
  return request<PairStatusResponse>(`/pair/${encodeURIComponent(requestId)}/status`);
}

export async function readSession(sessionId: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listConversations(sessionId: string): Promise<Conversation[]> {
  const body = await request<{ conversations: Conversation[] }>(
    `/sessions/${encodeURIComponent(sessionId)}/conversations`,
  );
  return body.conversations;
}

/**
 * Creates a conversation on one engine.
 *
 * The engine is chosen here and never again: the agent's context lives in an
 * engine session, so moving a conversation to another engine would abandon it.
 * See ADR-020.
 */
export async function createConversation(
  sessionId: string,
  engine?: string,
  model?: string,
): Promise<Conversation> {
  const choice = {
    ...(engine !== undefined ? { engine } : {}),
    ...(model !== undefined ? { model } : {}),
  };

  // Sent without a body when there is nothing to choose, so the request does not
  // announce json it never sends. The server then falls back to the engine the
  // terminal named.
  const hasChoice = Object.keys(choice).length > 0;

  return request<Conversation>(`/sessions/${encodeURIComponent(sessionId)}/conversations`, {
    method: 'POST',
    ...(hasChoice ? { body: JSON.stringify(choice) } : {}),
  });
}

/**
 * Changes the model of a conversation.
 *
 * Allowed where changing the engine is not: a different model of the same engine
 * still understands the engine session, so the context survives.
 */
export async function updateConversationModel(
  sessionId: string,
  conversationId: string,
  model: string | undefined,
): Promise<Conversation> {
  return request<Conversation>(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    headers: { [SESSION_HEADER]: sessionId },
    body: JSON.stringify({ model: model ?? null }),
  });
}

/**
 * Loads a whole conversation: what was said and what the engine did.
 *
 * Activities may be absent when talking to a server that predates them, so the
 * list falls back to empty rather than leaving it undefined.
 */
export async function readTranscript(
  sessionId: string,
  conversationId: string,
): Promise<Transcript> {
  const body = await request<{ messages: Message[]; activities?: Activity[] }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers: { [SESSION_HEADER]: sessionId } },
  );

  return { messages: body.messages, activities: body.activities ?? [] };
}

export async function deleteConversation(sessionId: string, conversationId: string): Promise<void> {
  await request<{ success: boolean }>(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    headers: { [SESSION_HEADER]: sessionId },
  });
}
