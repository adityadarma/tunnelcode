export interface PairPendingResponse {
  status: 'pending';
  requestId: string;
  approvalNumber: string;
}

export interface PairStatusResponse {
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  sessionId?: string;
}

export interface SessionDetail {
  id: string;
  deviceName: string;
  workspace: string;
  engine: string;
  online: boolean;
  models: string[];
}

export interface Conversation {
  id: string;
  title: string | null;
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

/** Something the engine did during a turn, shown alongside the messages. */
export interface Activity {
  id: string;
  tool: string;
  target?: string;
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

export async function createConversation(sessionId: string): Promise<Conversation> {
  return request<Conversation>(`/sessions/${encodeURIComponent(sessionId)}/conversations`, {
    method: 'POST',
  });
}

/**
 * Loads a whole conversation: what was said and what the engine did.
 *
 * Activities may be absent when talking to a server that predates them, so the
 * list falls back to empty rather than leaving it undefined.
 */
export async function readTranscript(conversationId: string): Promise<Transcript> {
  const body = await request<{ messages: Message[]; activities?: Activity[] }>(
    `/conversations/${encodeURIComponent(conversationId)}/messages`,
  );

  return { messages: body.messages, activities: body.activities ?? [] };
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await request<{ success: boolean }>(`/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}
