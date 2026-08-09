import { useState } from 'react';
import { renderFormattedContent } from './markdown.js';

interface ReasoningBlockProps {
  /** The thinking itself, as the engine reported it. */
  content: string;
  /** True while fragments are still arriving, so the label says it is under way. */
  live?: boolean;
}

/**
 * A stretch of the model working itself out, folded away.
 *
 * Folded rather than laid out with the answer because it was never addressed to the
 * reader: an answer is what the agent decided to say, and this is how it got there.
 * Kept on screen rather than dropped because it is the only thing that explains a
 * turn nobody was watching, and because a long silence with nothing in it reads as
 * a stall. Closed by default so the transcript still reads as a conversation.
 * See ADR-037.
 */
export function ReasoningBlock({ content, live }: ReasoningBlockProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Said in words rather than left to the animation, so the state survives without
  // colour or motion.
  const label = live === true ? 'Thinking…' : 'Thought';

  return (
    <div className="reasoning-block">
      <button
        type="button"
        className="reasoning-summary"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        <span className="reasoning-label">{label}</span>
        <span className="reasoning-toggle-icon">
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
      </button>

      {/* Nothing is rendered while closed, so a turn that thought for a long time
          costs the transcript one line rather than pages of deliberation. */}
      {expanded && content !== '' && (
        <div className="reasoning-content">{renderFormattedContent(content)}</div>
      )}
    </div>
  );
}
