import { useEffect, useRef } from 'react';
import type { Activity, Message } from '../api.js';

interface MessageListProps {
  messages: Message[];
  activities: Activity[];
  /** Streamed assistant text that has not been stored yet. */
  streaming: string | undefined;
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

  // Interleave text and activities chronologically within assistant turns
  for (const turn of turns) {
    if (turn.kind === 'assistant') {
      const textItems = turn.items.filter(
        (it): it is Extract<AssistantItem, { kind: 'text' }> => it.kind === 'text',
      );
      const activityItems = turn.items.filter(
        (it): it is Extract<AssistantItem, { kind: 'activity' }> => it.kind === 'activity',
      );

      if (textItems.length > 0 && activityItems.length > 0) {
        const firstText = textItems[0];
        if (firstText !== undefined) {
          const paragraphs = firstText.content.split(/\n\n+/);
          // If first text was finalized after activities but has multiple paragraphs,
          // paragraph 1 preceded activities and paragraph 2+ followed activities.
          if (
            paragraphs.length > 1 &&
            paragraphs[0] !== undefined &&
            activityItems.some((act) => act.at < firstText.at)
          ) {
            const leadingText = paragraphs[0];
            const trailingText = paragraphs.slice(1).join('\n\n');

            const reordered: AssistantItem[] = [
              { ...firstText, content: leadingText, at: turn.createdAt - 1 },
              ...activityItems.sort((a, b) => a.at - b.at),
              { ...firstText, id: `${firstText.id}-rest`, content: trailingText, at: firstText.at },
              ...textItems.slice(1),
            ];
            turn.items = reordered;
          } else {
            turn.items.sort((a, b) => a.at - b.at);
          }
        }
      } else {
        turn.items.sort((a, b) => a.at - b.at);
      }
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

/**
 * Ordered conversation history. Roles are labelled in text rather than by colour
 * alone, so the distinction survives without colour vision.
 */
export function MessageList({
  messages,
  activities,
  streaming,
}: MessageListProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, activities, streaming]);

  if (messages.length === 0 && activities.length === 0 && streaming === undefined) {
    return (
      <div className="messages empty">
        <p className="muted">No messages yet. Ask something to get started.</p>
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
                    {renderFormattedContent(item.content)}
                    {item.partial === true && (
                      <p className="partial-notice muted">Answer stopped before it finished.</p>
                    )}
                  </div>
                ) : (
                  <div key={item.id} className="activity-pill-wrapper">
                    <p
                      className={
                        item.activity.blocked === true ? 'activity activity-blocked' : 'activity'
                      }
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
                        <span>{item.activity.tool}</span>
                      </span>
                      {/* Said in words rather than by colour alone: a call that
                          never ran must not read like one that did. */}
                      {item.activity.blocked === true && (
                        <span className="activity-blocked-label">blocked</span>
                      )}
                      {item.activity.target !== undefined && (
                        <span className="activity-target mono">{item.activity.target}</span>
                      )}
                      {item.activity.reason !== undefined && (
                        <span className="activity-target">{item.activity.reason}</span>
                      )}
                    </p>
                  </div>
                ),
              )}
              {turn.isStreaming && (
                <div className="typing-indicator-row">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="muted">typing…</span>
                </div>
              )}
            </div>
          </article>
        ),
      )}
    </div>
  );
}
