export interface PairPendingResponse {
  status: 'pending';
  requestId: string;
  approvalNumber: string;
}

export interface PairStatusResponse {
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  sessionId?: string;
}

/**
 * One model an engine can answer with.
 *
 * The id is what the engine takes back, the label is what is shown. They differ for
 * engines whose ids are parameterised or opaque. See ADR-051.
 */
export interface EngineModel {
  id: string;
  label: string;
}

/** An engine the paired machine can run, with the models it reported. */
export interface DeviceEngine {
  /** Recorded on a conversation and matched against. */
  name: string;
  /** Shown to the reader, written as the engine's vendor writes it. */
  label: string;
  models: EngineModel[];
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
  /** CLI version at pairing time. Null when the CLI did not report one. */
  cliVersion: string | null;
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
  /**
   * Every token this conversation has spent, added up across its turns.
   *
   * Not a measure of context: each turn resends the conversation, so this counts
   * the same context once per turn. Null when no turn has ever reported a count,
   * which is where a conversation on an engine that cannot count stays.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * What the last turn to report spent, which stands for how much context the
   * conversation now carries.
   */
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One agent session found on the paired machine, as the CLI reported it.
 *
 * Only enough to recognise a session in the picker: the transcript itself is
 * fetched when the reader chooses one to import.
 */
export interface SessionSummary {
  /** Identifier the engine stores the session under, passed back to import it. */
  id: string;
  /** Derived from the first thing the user said, so it reads as a subject line. */
  title: string;
  /** ISO 8601, used to order the list and shown as a relative time. */
  lastActiveAt: string;
  /** User and assistant messages together. */
  messageCount: number;
  /** Tail of the last answer, truncated by the CLI. */
  preview: string;
}

/**
 * The answer to "what has this engine got on that machine?".
 *
 * `sessions` alone cannot say why it is empty, and the two reasons want different
 * sentences: an engine that cannot be read at all is not an engine that was read
 * and held nothing. `supported: false` means the scan will never work here and
 * `reason` says why in words the CLI already wrote for a reader.
 */
export interface AgentSessionListing {
  sessions: SessionSummary[];
  supported: boolean;
  reason?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /**
   * True when the turn ended partway and this is only what the engine managed to
   * say. Absent on a server that predates the flag, which is read as complete.
   */
  partial?: boolean;
  /**
   * Why it ended partway: `stopped` when the user asked, `failed` otherwise.
   *
   * Null or absent on a record written before this was kept, which is shown as an
   * answer that stopped without saying who stopped it. See ADR-042.
   */
  interruption?: 'stopped' | 'failed' | null;
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

/**
 * A stretch of the model working itself out, shown folded beside the answer.
 *
 * Kept out of the messages because it was never addressed to the reader: an answer
 * is what the agent decided to say, and this is how it got there. See ADR-037.
 */
export interface Reasoning {
  id: string;
  content: string;
  createdAt: number;
}

export interface Transcript {
  messages: Message[];
  activities: Activity[];
  reasonings: Reasoning[];
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
 * Every request is authenticated by the session cookie, which the browser attaches
 * on its own and this code cannot read. Nothing here carries a credential: the ids
 * in these paths say which session or conversation is meant, and the server decides
 * whether the caller is entitled to it. See ADR-041.
 */
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
  return request<PairPendingResponse>('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function readPairStatus(requestId: string): Promise<PairStatusResponse> {
  return request<PairStatusResponse>(`/api/pair/${encodeURIComponent(requestId)}/status`);
}

export async function readSession(sessionId: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listConversations(sessionId: string): Promise<Conversation[]> {
  const body = await request<{ conversations: Conversation[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/conversations`,
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

  return request<Conversation>(`/api/sessions/${encodeURIComponent(sessionId)}/conversations`, {
    method: 'POST',
    ...(hasChoice ? { body: JSON.stringify(choice) } : {}),
  });
}

/**
 * Lists the agent sessions the paired machine holds for one engine.
 *
 * The server relays the question to the CLI, which scans that engine's local
 * storage. The array comes back ordered by `lastActiveAt` descending, and is
 * passed on in that order rather than sorted again here.
 *
 * The whole body is returned rather than just the list, because `supported` and
 * `reason` are what let the picker say "this cannot be read" instead of "you have
 * no history". `supported` falls back to true so a server that predates the field
 * still reads as scannable, matching the protocol's own default.
 */
export async function listAgentSessions(
  sessionId: string,
  engine: string,
): Promise<AgentSessionListing> {
  const body = await request<{
    sessions: SessionSummary[];
    supported?: boolean;
    reason?: string;
  }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent-sessions?engine=${encodeURIComponent(engine)}`,
  );

  return {
    sessions: body.sessions,
    supported: body.supported ?? true,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  };
}

/**
 * Imports one of those agent sessions as a new conversation.
 *
 * The conversation comes back with its messages and activities already stored, so
 * the transcript endpoint has everything the moment it is made active.
 */
export async function importAgentSession(
  sessionId: string,
  engine: string,
  agentSessionId: string,
): Promise<Conversation> {
  return request<Conversation>(
    `/api/sessions/${encodeURIComponent(sessionId)}/conversations/import`,
    {
      method: 'POST',
      body: JSON.stringify({ engine, sessionId: agentSessionId }),
    },
  );
}

/**
 * Changes the model of a conversation.
 *
 * Allowed where changing the engine is not: a different model of the same engine
 * still understands the engine session, so the context survives.
 */
export async function updateConversationModel(
  conversationId: string,
  model: string | undefined,
): Promise<Conversation> {
  return request<Conversation>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ model: model ?? null }),
  });
}

/**
 * Loads a whole conversation: what was said, what the engine did, and what it was
 * working out while it did.
 *
 * Activities and thinking may be absent when talking to a server that predates
 * them, so each list falls back to empty rather than being left undefined.
 */
export async function readTranscript(conversationId: string): Promise<Transcript> {
  const body = await request<{
    messages: Message[];
    activities?: Activity[];
    reasonings?: Reasoning[];
  }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`);

  return {
    messages: body.messages,
    activities: body.activities ?? [],
    reasonings: body.reasonings ?? [],
  };
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await request<{ success: boolean }>(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  });
}

/**
 * The key a browser subscribes to notifications with.
 *
 * Fetched rather than baked in: it belongs to the deployment, and a subscription
 * made against a different one is refused by the push service. See ADR-045.
 */
export async function readPushKey(): Promise<string> {
  const body = await request<{ publicKey: string }>('/api/push/key');
  return body.publicKey;
}

/** A subscription in the shape the server stores it. */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Tells the server where to reach this browser while it is closed. */
export async function savePushSubscription(subscription: PushSubscriptionPayload): Promise<void> {
  await request<Record<string, never>>('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

/** Tells the server to stop, which it does whether or not it knew the endpoint. */
export async function deletePushSubscription(endpoint: string): Promise<void> {
  await request<Record<string, never>>('/api/push/unsubscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  });
}
