import type { Conversation, DeviceEngine } from '../api.js';

/**
 * How an engine is named in a row.
 *
 * Falls back to the stored name when the device no longer reports that engine, which
 * is the honest answer: a conversation created on an engine since uninstalled still
 * says what it runs on rather than reading as blank.
 */
function describeEngine(engines: DeviceEngine[], name: string): string {
  return engines.find((engine) => engine.name === name)?.label ?? name;
}

/**
 * How a model is named in a row.
 *
 * The label rather than the id, so a row does not carry a line of Cursor's bracketed
 * parameters. Falls back to the id for the same reason as above.
 */
function describeModel(engines: DeviceEngine[], engineName: string, modelId: string): string {
  const engine = engines.find((entry) => entry.name === engineName);
  return engine?.models.find((model) => model.id === modelId)?.label ?? modelId;
}
import { NewConversationButton } from './NewConversationButton.js';

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | undefined;
  /** Engines the paired machine can run, offered when starting a conversation. */
  engines: DeviceEngine[];
  /** Paired session the agent session list and import are relayed through. */
  sessionId: string;
  /** The machine's default engine, preselected when starting a conversation. */
  defaultEngine?: string | undefined;
  /** True while the device is offline, when a new conversation cannot be created. */
  createDisabled: boolean;
  /**
   * Whether the paired machine is connected. Separate from `createDisabled` because
   * importing needs the machine reachable right now to scan it, while creating only
   * needs it reachable by the time a prompt is sent.
   */
  online: boolean;
  onSelect: (id: string) => void;
  onCreate: (engine: string | undefined, model: string | undefined) => void;
  /** Receives the conversation an agent session was imported into. */
  onImport: (conversation: Conversation) => void;
  onOpenModal?: (() => void) | undefined;
  onDelete?: (id: string) => void;
  /**
   * Dismisses the sidebar. Named for what the button does rather than for a
   * toggle, because the sidebar it dismisses is not the one that reopens it: the
   * drawer comes back from the hamburger, the desktop column from the header.
   */
  onHideSidebar?: (() => void) | undefined;
}

/**
 * Conversation switcher. Untitled entries fall back to a label rather than an
 * empty row, since a conversation is only named once its first prompt arrives.
 *
 * Each row names the engine and model it runs on, because those are fixed per
 * conversation now and the list is where two conversations are compared.
 * See ADR-020.
 */
export function ConversationList({
  conversations,
  activeId,
  engines,
  sessionId,
  defaultEngine,
  createDisabled,
  online,
  onSelect,
  onCreate,
  onImport,
  onOpenModal,
  onDelete,
  onHideSidebar,
}: ConversationListProps): React.JSX.Element {
  const sortedConversations = [...conversations].sort(
    (left, right) => right.createdAt - left.createdAt,
  );

  return (
    <nav aria-label="Conversations">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <svg
            className="icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <h2>Conversations</h2>
        </div>
        <div className="sidebar-head-actions">
          <NewConversationButton
            engines={engines}
            sessionId={sessionId}
            defaultEngine={defaultEngine}
            disabled={createDisabled}
            online={online}
            onCreate={onCreate}
            onImport={onImport}
            onOpenModal={onOpenModal}
          />
          {onHideSidebar && (
            <button
              type="button"
              className="btn-toggle-sidebar"
              onClick={onHideSidebar}
              title="Hide sidebar"
              aria-label="Hide sidebar"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {sortedConversations.length === 0 ? (
        <div className="empty-conversations">
          <p className="muted padded">No conversations yet.</p>
        </div>
      ) : (
        <ul className="conversation-items">
          {sortedConversations.map((conversation) => (
            <li key={conversation.id} className="conversation-item-wrapper">
              <button
                type="button"
                className={`conversation-item ${conversation.id === activeId ? 'active' : ''}`}
                aria-current={conversation.id === activeId ? 'true' : undefined}
                onClick={() => {
                  onSelect(conversation.id);
                }}
              >
                <svg
                  className="item-icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span className="item-text">
                  <span className="item-title">
                    {conversation.title ?? 'Untitled conversation'}
                  </span>
                  {conversation.engine !== null && (
                    <span className="item-meta">
                      {describeEngine(engines, conversation.engine)}
                      {conversation.model !== null &&
                        ` · ${describeModel(engines, conversation.engine, conversation.model)}`}
                    </span>
                  )}
                </span>
              </button>
              {onDelete !== undefined && (
                <button
                  type="button"
                  className="btn-delete-conv"
                  aria-label={`Delete ${conversation.title ?? 'conversation'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(conversation.id);
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
