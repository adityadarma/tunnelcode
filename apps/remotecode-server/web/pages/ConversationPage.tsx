import { useCallback, useEffect, useRef, useState } from 'react';
import { createConversation, deleteConversation, listConversations, readSession, readTranscript } from '../api.js';
import type { Activity, Conversation, Message, SessionDetail } from '../api.js';
import { Composer } from '../components/Composer.js';
import { ConversationList } from '../components/ConversationList.js';
import { DevicePanel } from '../components/DevicePanel.js';
import { MessageList } from '../components/MessageList.js';
import { ModelPicker } from '../components/ModelPicker.js';
import { ThemeToggle } from '../components/ThemeToggle.js';
import {
  readStoredActiveConversationId,
  readStoredModel,
  readStoredTheme,
  storeActiveConversationId,
  storeModel,
  storeTheme,
} from '../storage.js';
import { useSessionSocket } from '../useSessionSocket.js';

interface ConversationPageProps {
  sessionId: string;
  onSessionLost: () => void;
}

interface ServerEvent {
  type?: unknown;
  conversationId?: unknown;
  id?: unknown;
  role?: unknown;
  content?: unknown;
  partial?: unknown;
  createdAt?: unknown;
  text?: unknown;
  message?: unknown;
  tool?: unknown;
  target?: unknown;
  activeTurn?: unknown;
}

/** A turn still being answered, as reported when the socket attaches. */
interface RunningTurn {
  conversationId: string;
  turnId: string;
}

/**
 * Reads the turn reported by an attach, if any.
 *
 * Shaped defensively because this crosses the socket: anything that is not a
 * well formed turn is treated as nothing running.
 */
function readActiveTurn(value: unknown): RunningTurn | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as { conversationId?: unknown; turnId?: unknown };

  if (typeof candidate.conversationId !== 'string' || typeof candidate.turnId !== 'string') {
    return undefined;
  }

  return { conversationId: candidate.conversationId, turnId: candidate.turnId };
}

/**
 * Conversation screen.
 *
 * History comes from the server, so a refresh restores the whole conversation.
 * Streaming text is held separately and replaced by the stored message once the
 * turn finishes, which keeps the transcript in one place. See ADR-007, ADR-008.
 */
export function ConversationPage({
  sessionId,
  onSessionLost,
}: ConversationPageProps): React.JSX.Element {
  const [session, setSession] = useState<SessionDetail | undefined>(undefined);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [streaming, setStreaming] = useState<string | undefined>(undefined);
  /**
   * The turn the device is busy with, tracked separately from the streaming text.
   *
   * A device answers one prompt at a time, so a turn started in another
   * conversation still blocks this one. Streaming text alone could not express
   * that, and switching conversations clears it.
   */
  const [runningTurn, setRunningTurn] = useState<RunningTurn | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(() => readStoredModel());
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readStoredTheme() ?? 'dark');
  const [error, setError] = useState<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = (): void => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    storeTheme(next);
  };

  const activeIdRef = useRef<string | undefined>(undefined);
  activeIdRef.current = activeId;

  // Read when switching conversations, which must not refetch the transcript just
  // because a turn started or ended.
  const runningTurnRef = useRef<RunningTurn | undefined>(undefined);
  runningTurnRef.current = runningTurn;

  const selectActiveId = useCallback((id: string | undefined): void => {
    setActiveId(id);
    if (id !== undefined) {
      storeActiveConversationId(id);
    }
  }, []);

  const handleEvent = useCallback((raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }

    const event = raw as ServerEvent;

    switch (event.type) {
      // The socket has just attached, which is the only moment the browser learns
      // what was already running. A refresh mid-answer lands here.
      case 'attached': {
        const active = readActiveTurn(event.activeTurn);
        setRunningTurn(active);

        // Deltas sent while the socket was gone are lost for good, so nothing can
        // be shown until the turn finishes and stores its message. An empty
        // string still marks the answer as pending.
        setStreaming(active !== undefined && active.conversationId === activeIdRef.current ? '' : undefined);
        return;
      }

      case 'message': {
        if (event.conversationId !== activeIdRef.current) {
          return;
        }

        const message: Message = {
          id: String(event.id),
          role: event.role === 'assistant' ? 'assistant' : 'user',
          content: String(event.content),
          ...(event.partial === true ? { partial: true } : {}),
          createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
        };

        if (message.role === 'user') {
          const derivedTitle = deriveTitle(message.content);
          setConversations((current) =>
            current.map((item) =>
              item.id === activeIdRef.current &&
              (item.title === null || item.title === undefined || item.title === '')
                ? { ...item, title: derivedTitle }
                : item,
            ),
          );
        }

        setMessages((current) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );

        if (message.role === 'assistant') {
          setStreaming(undefined);
        }
        return;
      }

      case 'activity': {
        if (event.conversationId !== activeIdRef.current) {
          return;
        }

        const activity: Activity = {
          id: String(event.id),
          tool: String(event.tool),
          ...(typeof event.target === 'string' ? { target: event.target } : {}),
          createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
        };

        setActivities((current) =>
          current.some((item) => item.id === activity.id) ? current : [...current, activity],
        );
        return;
      }

      case 'delta': {
        if (event.conversationId !== activeIdRef.current) {
          return;
        }
        const text = String(event.text);
        setStreaming((current) => (current ?? '') + text);
        return;
      }

      // Sent for every turn that ends, including one that failed, and for turns in
      // conversations this browser is not watching. Clearing here is what frees
      // the composer again.
      case 'turn_done':
        setRunningTurn(undefined);
        setStreaming(undefined);
        return;

      case 'error':
        setError(String(event.message));
        return;

      default:
        return;
    }
  }, []);

  const socket = useSessionSocket({ sessionId, onMessage: handleEvent });

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const detail = await readSession(sessionId);
      setSession(detail);
      const stored = readStoredModel();
      if (stored !== undefined && detail.models.includes(stored)) {
        setModel(stored);
      } else if (detail.models.length > 0) {
        setModel((current) => (current !== undefined && detail.models.includes(current) ? current : detail.models[0]));
      }
    } catch {
      onSessionLost();
    }
  }, [sessionId, onSessionLost]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // The socket reports device status, so the summary follows it without polling.
  useEffect(() => {
    setSession((current) =>
      current === undefined ? current : { ...current, online: socket.online },
    );
  }, [socket.online]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await listConversations(sessionId);
        setConversations(list);

        const sorted = [...list].sort(
          (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
        );
        const storedActiveId = readStoredActiveConversationId();
        const foundStored =
          storedActiveId !== undefined && list.some((item) => item.id === storedActiveId);
        const initialId = foundStored ? storedActiveId : sorted[0]?.id;

        setActiveId((current) => {
          const next = current ?? initialId;
          if (next !== undefined) {
            storeActiveConversationId(next);
          }
          return next;
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot load conversations.');
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    // Switching conversations drops streaming text, unless the turn still running
    // belongs to the one being opened: that answer is still on its way.
    const running = runningTurnRef.current;
    setStreaming(running !== undefined && running.conversationId === activeId ? '' : undefined);

    if (activeId === undefined) {
      setMessages([]);
      setActivities([]);
      return;
    }

    void (async () => {
      try {
        const transcript = await readTranscript(activeId);
        setMessages(transcript.messages);
        setActivities(transcript.activities);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot load messages.');
      }
    })();
  }, [activeId]);

  const create = (): void => {
    void (async () => {
      try {
        const conversation = await createConversation(sessionId);
        setConversations((current) => [...current, conversation]);
        selectActiveId(conversation.id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot create a conversation.');
      }
    })();
  };

  const removeConversation = (id: string): void => {
    void (async () => {
      try {
        await deleteConversation(id);
        setConversations((current) => {
          const updated = current.filter((item) => item.id !== id);
          if (activeIdRef.current === id) {
            const sorted = [...updated].sort(
              (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
            );
            const nextActiveId = sorted[0]?.id;
            setActiveId(nextActiveId);
            if (nextActiveId !== undefined) {
              storeActiveConversationId(nextActiveId);
            }
          }
          return updated;
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Cannot delete conversation.');
      }
    })();
  };

  /**
   * Ends the session on the paired machine, then forgets it locally.
   *
   * Order matters: the socket has to carry the message before it is torn down.
   */
  const disconnect = (): void => {
    socket.disconnect();
    onSessionLost();
  };

  function deriveTitle(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
  }

  const send = (text: string): void => {
    if (activeId === undefined) {
      return;
    }

    setError(undefined);
    setStreaming('');

    const derivedTitle = deriveTitle(text);
    setConversations((current) =>
      current.map((item) =>
        item.id === activeId && (item.title === null || item.title === undefined || item.title === '')
          ? { ...item, title: derivedTitle }
          : item,
      ),
    );

    socket.sendPrompt(activeId, text, model);
  };

  const changeModel = (newModel: string | undefined): void => {
    setModel(newModel);
    if (newModel !== undefined) {
      storeModel(newModel);
    }
  };

  const offline = !socket.online;

  // A device answers one prompt at a time, so a turn running in another
  // conversation blocks this one too. Offering a composer whose prompt is certain
  // to be refused is what made a refresh mid-answer confusing.
  const busyElsewhere = runningTurn !== undefined && runningTurn.conversationId !== activeId;
  const sendDisabled =
    activeId === undefined || offline || streaming !== undefined || busyElsewhere;

  const disabledReason = offline
    ? 'The device is offline.'
    : activeId === undefined
      ? 'Create a conversation to start asking.'
      : busyElsewhere
        ? 'The agent is answering in another conversation.'
        : 'Waiting for the answer…';

  return (
    <div className={`layout ${menuOpen ? 'menu-open' : ''}`}>
      <div
        className="layout-overlay"
        onClick={() => {
          setMenuOpen(false);
        }}
      />

      <aside className="sidebar">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            selectActiveId(id);
            setMenuOpen(false);
          }}
          onCreate={() => {
            create();
            setMenuOpen(false);
          }}
          onDelete={(id) => {
            removeConversation(id);
          }}
        />

        {session !== undefined && (
          <div className="device-wrapper">
            <DevicePanel
              session={{ ...session, online: socket.online }}
              onDisconnect={disconnect}
            />
          </div>
        )}
      </aside>

      <main className="main">
        <header className="main-head">
          <div className="main-head-title">
            <button
              type="button"
              className="menu-button ghost"
              onClick={() => {
                setMenuOpen(!menuOpen);
              }}
              aria-label="Toggle menu"
            >
              ☰
            </button>
            <h1>{conversations.find((item) => item.id === activeId)?.title ?? 'RemoteCode'}</h1>
          </div>
          <div className="main-head-controls">
            <ModelPicker
              models={session?.models ?? []}
              selected={model}
              disabled={offline}
              onChange={changeModel}
            />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </header>

        {error !== undefined && (
          <p role="alert" className="error padded">
            {error}
          </p>
        )}

        <MessageList messages={messages} activities={activities} streaming={streaming} />

        <Composer disabled={sendDisabled} disabledReason={disabledReason} onSend={send} />
      </main>
    </div>
  );
}
