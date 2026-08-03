import { useEffect, useRef } from 'react';
import type { Activity, Message, Reasoning } from '../api.js';
import { ActivityItem } from './ActivityItem.js';
import { EmptyConversation } from './EmptyConversation.js';
import { ReasoningBlock } from './ReasoningBlock.js';
import { renderFormattedContent } from './markdown.js';
import { describeTurn } from './turn-status.js';
import { buildTurns, lastOf } from './turns.js';

interface MessageListProps {
  messages: Message[];
  activities: Activity[];
  /**
   * Stretches of thinking, placed on the timeline like activities.
   *
   * Optional so a caller that has none does not have to say so, which is also what
   * a server predating them reports. See ADR-037.
   */
  reasonings?: Reasoning[];
  /** Streamed assistant text that has not been stored yet. */
  streaming: string | undefined;
  /**
   * Thinking that is still arriving, shown live and replaced by the stored block
   * once the model stops thinking.
   */
  reasoningStream?: string | undefined;
  /** The workspace path of the current session, used to shorten paths. */
  workspace?: string | undefined;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Ordered conversation history. Roles are labelled in text rather than by colour
 * alone, so the distinction survives without colour vision.
 */
export function MessageList({
  messages,
  activities,
  reasonings = [],
  streaming,
  reasoningStream,
  workspace,
}: MessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, activities, reasonings, streaming, reasoningStream]);

  if (
    messages.length === 0 &&
    activities.length === 0 &&
    reasonings.length === 0 &&
    streaming === undefined
  ) {
    return <EmptyConversation />;
  }

  const turns = buildTurns(messages, activities, reasonings, streaming, reasoningStream);

  return (
    <div
      ref={containerRef}
      className="messages"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {turns.map((turn) =>
        turn.kind === 'user' ? (
          <article key={turn.id} className="message message-user">
            <header>
              <span className="role">You</span>
              <time dateTime={new Date(turn.message.createdAt).toISOString()}>
                {formatTime(turn.message.createdAt)}
              </time>
            </header>
            {renderFormattedContent(turn.message.content)}
          </article>
        ) : (
          <article key={turn.id} className="message message-assistant">
            <header>
              <span className="role">Assistant</span>
              <time dateTime={new Date(turn.createdAt).toISOString()}>
                {formatTime(turn.createdAt)}
              </time>
            </header>
            <div className="assistant-content">
              {turn.items.map((item) =>
                item.kind === 'text' ? (
                  <div key={item.id} className="message-text-block">
                    {/* A turn that was cut off before it said anything still
                        leaves a record, so the content can be empty. Rendering it
                        would add a blank paragraph above the notice that is the
                        whole point of the record. */}
                    {item.content !== '' && renderFormattedContent(item.content)}
                    {item.partial === true && (
                      <p className="partial-notice muted">Answer stopped before it finished.</p>
                    )}
                  </div>
                ) : item.kind === 'reasoning' ? (
                  <ReasoningBlock
                    key={item.id}
                    content={item.content}
                    {...(item.live === true ? { live: true } : {})}
                  />
                ) : (
                  <ActivityItem key={item.id} activity={item.activity} workspace={workspace} />
                ),
              )}
              {turn.isStreaming && (
                <div className="typing-indicator-row">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  {/* Names what the turn is doing rather than always claiming to
                      think: a minute spent on a command is work, and saying
                      "thinking" over it is both wrong and the least useful thing
                      the line could say. See ADR-038. */}
                  <span className="muted">{describeTurn(lastOf(turn.items))}</span>
                </div>
              )}
            </div>
          </article>
        ),
      )}
    </div>
  );
}
