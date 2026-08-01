import type { Conversation, DeviceEngine } from '../api.js';
import { NewConversationButton } from './NewConversationButton.js';

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | undefined;
  /** Engines the paired machine can run, offered when starting a conversation. */
  engines: DeviceEngine[];
  /** True while the device is offline, when a new conversation cannot be created. */
  createDisabled: boolean;
  onSelect: (id: string) => void;
  onCreate: (engine: string | undefined, model: string | undefined) => void;
  onOpenModal?: (() => void) | undefined;
  onDelete?: (id: string) => void;
  onToggleSidebar?: (() => void) | undefined;
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
  createDisabled,
  onSelect,
  onCreate,
  onOpenModal,
  onDelete,
  onToggleSidebar,
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
            disabled={createDisabled}
            onCreate={onCreate}
            onOpenModal={onOpenModal}
          />
          {onToggleSidebar && (
            <button
              type="button"
              className="btn-toggle-sidebar"
              onClick={onToggleSidebar}
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
                      {conversation.engine}
                      {conversation.model !== null && ` · ${conversation.model}`}
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
