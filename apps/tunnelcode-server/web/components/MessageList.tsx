import { useEffect, useRef, useState } from 'react';
import type { Activity, Message } from '../api.js';

interface MessageListProps {
  messages: Message[];
  activities: Activity[];
  /** Streamed assistant text that has not been stored yet. */
  streaming: string | undefined;
  /** The workspace path of the current session, used to shorten paths. */
  workspace?: string | undefined;
}

type AssistantItem =
  | { kind: 'text'; id: string; content: string; at: number; partial?: boolean }
  | { kind: 'activity'; id: string; activity: Activity; at: number };

interface UserTurn {
  kind: 'user';
  id: string;
  message: Message;
}

interface AssistantTurn {
  kind: 'assistant';
  id: string;
  createdAt: number;
  items: AssistantItem[];
  isStreaming?: boolean;
}

type Turn = UserTurn | AssistantTurn;

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Groups user messages and assistant messages/activities into ordered turns.
 *
 * Interleaves assistant text paragraphs and tool activities chronologically:
 * Initial explanation -> Tool activities -> Subsequent summary.
 */
function buildTurns(
  messages: Message[],
  activities: Activity[],
  streaming: string | undefined,
): Turn[] {
  type RawEntry =
    | { kind: 'user-msg'; at: number; message: Message }
    | { kind: 'assistant-msg'; at: number; message: Message }
    | { kind: 'activity'; at: number; activity: Activity };

  const rawEntries: RawEntry[] = [
    ...messages.map((m): RawEntry => ({
      kind: m.role === 'user' ? 'user-msg' : 'assistant-msg',
      at: m.createdAt,
      message: m,
    })),
    ...activities.map((a): RawEntry => ({
      kind: 'activity',
      at: a.createdAt,
      activity: a,
    })),
  ].sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at;
    }
    if (left.kind === right.kind) {
      return 0;
    }
    return left.kind === 'user-msg' ? -1 : right.kind === 'user-msg' ? 1 : 0;
  });

  const turns: Turn[] = [];

  for (const entry of rawEntries) {
    if (entry.kind === 'user-msg') {
      turns.push({
        kind: 'user',
        id: entry.message.id,
        message: entry.message,
      });
      continue;
    }

    const item: AssistantItem =
      entry.kind === 'assistant-msg'
        ? {
            kind: 'text',
            id: entry.message.id,
            content: entry.message.content,
            at: entry.at,
            ...(entry.message.partial === true ? { partial: true } : {}),
          }
        : { kind: 'activity', id: entry.activity.id, activity: entry.activity, at: entry.at };

    const lastTurn = turns[turns.length - 1];
    if (lastTurn !== undefined && lastTurn.kind === 'assistant') {
      lastTurn.items.push(item);
    } else {
      turns.push({
        kind: 'assistant',
        id: `assistant-turn-${entry.kind === 'assistant-msg' ? entry.message.id : entry.activity.id}`,
        createdAt: entry.at,
        items: [item],
      });
    }
  }

  if (streaming !== undefined) {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn !== undefined && lastTurn.kind === 'assistant') {
      lastTurn.isStreaming = true;
      if (streaming !== '') {
        lastTurn.items.push({
          kind: 'text',
          id: 'streaming-text',
          content: streaming,
          at: Date.now(),
        });
      }
    } else {
      turns.push({
        kind: 'assistant',
        id: 'streaming-turn',
        createdAt: Date.now(),
        isStreaming: true,
        items:
          streaming !== ''
            ? [{ kind: 'text', id: 'streaming-text', content: streaming, at: Date.now() }]
            : [],
      });
    }
  }

  // Sort items within assistant turns chronologically.
  // The backend splits text streams into separate messages around tool calls,
  // so chronological sorting naturally interleaves text and tools.
  for (const turn of turns) {
    if (turn.kind === 'assistant') {
      turn.items.sort((a, b) => a.at - b.at);
    }
  }

  return turns;
}

interface MarkdownBlock {
  type: 'code' | 'paragraph' | 'heading' | 'list' | 'quote';
  lang?: string;
  code?: string;
  items?: string[];
  text?: string;
  level?: number;
}

function parseInlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|[*_][^*_]+[*_])/g);

  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`') && token.length > 1) {
      return (
        <code key={index} className="inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (
      (token.startsWith('**') && token.endsWith('**') && token.length > 3) ||
      (token.startsWith('__') && token.endsWith('__') && token.length > 3)
    ) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (
      (token.startsWith('*') && token.endsWith('*') && token.length > 2) ||
      (token.startsWith('_') && token.endsWith('_') && token.length > 2)
    ) {
      return <em key={index}>{token.slice(1, -1)}</em>;
    }
    return token;
  });
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let currentParagraphLines: string[] = [];

  const flushParagraph = (): void => {
    if (currentParagraphLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        text: currentParagraphLines.join('\n'),
      });
      currentParagraphLines = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({
          type: 'code',
          lang: codeLang,
          code: codeLines.join('\n'),
        });
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        flushParagraph();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] !== undefined && headingMatch[2] !== undefined) {
      flushParagraph();
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      continue;
    }

    const listMatch = line.match(/^(\*|-|\d+\.)\s+(.+)$/);
    if (listMatch && listMatch[2] !== undefined) {
      const itemText = listMatch[2];
      flushParagraph();
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === 'list' && lastBlock.items) {
        lastBlock.items.push(itemText);
      } else {
        blocks.push({
          type: 'list',
          items: [itemText],
        });
      }
      continue;
    }

    if (line.startsWith('>')) {
      flushParagraph();
      blocks.push({
        type: 'quote',
        text: line.slice(1).trim(),
      });
      continue;
    }

    currentParagraphLines.push(line);
  }

  if (inCode) {
    blocks.push({
      type: 'code',
      lang: codeLang,
      code: codeLines.join('\n'),
    });
  }

  flushParagraph();
  return blocks;
}

function renderFormattedContent(content: string): React.JSX.Element {
  const blocks = parseMarkdownBlocks(content);

  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <div key={index} className="code-block-wrapper">
              {block.lang !== undefined && block.lang !== '' && (
                <div className="code-block-header">{block.lang}</div>
              )}
              <pre className="code-block">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === 'heading') {
          return <h3 key={index}>{parseInlineMarkdown(block.text ?? '')}</h3>;
        }

        if (block.type === 'list') {
          return (
            <ul key={index} className="markdown-list">
              {block.items?.map((item, itemIdx) => (
                <li key={itemIdx}>{parseInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === 'quote') {
          return (
            <blockquote key={index} className="markdown-quote">
              {parseInlineMarkdown(block.text ?? '')}
            </blockquote>
          );
        }

        return <p key={index}>{parseInlineMarkdown(block.text ?? '')}</p>;
      })}
    </>
  );
}

function ActivityItem({
  activity,
  workspace,
}: {
  activity: Activity;
  workspace: string | undefined;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Checked by type rather than against undefined: the transcript endpoint returns
  // the stored row, whose empty columns are null, and a null here reached .split()
  // and took the whole page down with it.
  let displayTarget = typeof activity.target === 'string' ? activity.target : undefined;

  if (displayTarget !== undefined && workspace !== undefined) {
    // The workspace is where every path in a transcript starts, so naming it says
    // nothing: what is left is already relative to it. Dropped rather than replaced
    // with a prefix, because the leading marker was as much to read as the folder
    // name it stood in front of. Done everywhere in the string, since a shell
    // command carries paths inside it rather than as the whole of it.
    displayTarget = displayTarget.split(`${workspace}/`).join('');
    // The workspace on its own has no name left to show, so it stays a dot.
    displayTarget = displayTarget.split(workspace).join('.');
  }

  const hasOutput = typeof activity.output === 'string' && activity.output.length > 0;
  const reason = typeof activity.reason === 'string' ? activity.reason : undefined;

  return (
    <div className="activity-pill-wrapper">
      <div className={`activity-container ${activity.blocked ? 'activity-blocked' : ''}`}>
        <p
          className="activity"
          onClick={
            hasOutput
              ? () => {
                  setExpanded(!expanded);
                }
              : undefined
          }
          style={{ cursor: hasOutput ? 'pointer' : 'default' }}
        >
          <span className="activity-tool">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span>{activity.tool}</span>
          </span>
          {/* Said in words rather than by colour alone: a call that
              never ran must not read like one that did. */}
          {activity.blocked === true && <span className="activity-blocked-label">blocked</span>}
          {displayTarget !== undefined && (
            <span className="activity-target mono" title={displayTarget}>
              {displayTarget}
            </span>
          )}
          {reason !== undefined && <span className="activity-target">{reason}</span>}
          {hasOutput && (
            <span className="activity-toggle-icon">
              {expanded ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              )}
            </span>
          )}
        </p>
        {expanded && hasOutput && (
          <div className="activity-output-container">
            <pre className="activity-output-content">{activity.output}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ordered conversation history. Roles are labelled in text rather than by colour
 * alone, so the distinction survives without colour vision.
 */
export function MessageList({
  messages,
  activities,
  streaming,
  workspace,
}: MessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, activities, streaming]);

  if (messages.length === 0 && activities.length === 0 && streaming === undefined) {
    return (
      <div className="messages empty-state-container">
        <div className="empty-hero-glow" />
        <div className="empty-hero-content">
          <div className="empty-icon-badge">
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h2 className="empty-title">What would you like to build?</h2>
          <p className="muted empty-subtitle">No messages yet. Ask something to get started.</p>
          <div className="empty-features-grid">
            <div className="feature-chip">
              <span className="chip-icon">⚡</span>
              <span>Terminal Tunneling</span>
            </div>
            <div className="feature-chip">
              <span className="chip-icon">🔒</span>
              <span>Secure Pairing</span>
            </div>
            <div className="feature-chip">
              <span className="chip-icon">🤖</span>
              <span>Multi-Engine Selection</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const turns = buildTurns(messages, activities, streaming);

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
                ) : (
                  <ActivityItem key={item.id} activity={item.activity} workspace={workspace} />
                ),
              )}
              {turn.isStreaming && (
                <div className="typing-indicator-row">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="muted">thinking…</span>
                </div>
              )}
            </div>
          </article>
        ),
      )}
    </div>
  );
}
