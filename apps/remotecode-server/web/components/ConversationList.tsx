import type { Conversation } from '../api.js';

interface ConversationListProps {
  conversations: Conversation[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete?: (id: string) => void;
}

/**
 * Conversation switcher. Untitled entries fall back to a label rather than an
 * empty row, since a conversation is only named once its first prompt arrives.
 */
export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: ConversationListProps): React.JSX.Element {
  const sortedConversations = [...conversations].sort(
    (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
  );

  return (
    <nav aria-label="Conversations">
      <div className="sidebar-head">
        <div className="sidebar-title">
          <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <h2>Conversations</h2>
        </div>
        <button type="button" className="btn-new" onClick={onCreate}>
          <span aria-hidden="true" className="btn-new-icon">+</span> New
        </button>
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
                <svg className="item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
                <span className="item-title">{conversation.title ?? 'Untitled conversation'}</span>
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
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
