interface TokenUsageProps {
  /** What the last turn to report spent, which stands for the context it carried. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Every token the conversation has spent, when anything has been counted.
   *
   * Shown beside the turn's own figures rather than instead of them: every turn
   * resends the conversation, so the total is what it cost while the turn's input is
   * roughly how much context it now carries. Optional, because a conversation from
   * before this was stored has a turn to report and no total.
   */
  totalInputTokens?: number | undefined;
  totalOutputTokens?: number | undefined;
}

/** Formats a number compactly: 1234 → "1.2k", 123 → "123". */
function compact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}m`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Displays what the last turn spent, and what the conversation has spent in all,
 * next to the model picker.
 *
 * Read from the conversation rather than from the turn that is running, which is why
 * it says "last turn": the figures survive a refresh and a switch between
 * conversations, and they stay on screen while the next turn works instead of
 * blinking out and back.
 *
 * Shown as a compact pill so it occupies no more space than the model name beside
 * it, with the full figures in the tooltip. Absent when the engine did not report
 * usage, which keeps the toolbar clean for engines that cannot count.
 *
 * No percentage is shown. A share of the context window would need the window's
 * size, and no engine reports that in a way that holds across models — Cursor puts
 * it inside the model id and its default model carries none — so a percentage here
 * would be a number nobody counted.
 */
export function TokenUsage({
  inputTokens,
  outputTokens,
  totalInputTokens,
  totalOutputTokens,
}: TokenUsageProps): React.JSX.Element {
  const total =
    totalInputTokens !== undefined && totalOutputTokens !== undefined
      ? totalInputTokens + totalOutputTokens
      : undefined;

  const title = [
    `Last turn — input: ${inputTokens.toLocaleString()} tokens · output: ${outputTokens.toLocaleString()} tokens`,
    ...(totalInputTokens !== undefined && totalOutputTokens !== undefined
      ? [
          `Conversation — input: ${totalInputTokens.toLocaleString()} tokens · output: ${totalOutputTokens.toLocaleString()} tokens`,
          'The conversation total counts every turn, and each turn resends the conversation, so it is what was spent rather than how much context is in use.',
        ]
      : []),
  ].join('\n');

  return (
    <span className="token-usage" title={title}>
      <svg
        className="token-usage-icon"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2v20M2 12h20" />
        <path d="M12 2a10 10 0 0 1 10 10" />
        <path d="M12 2a10 10 0 0 0-10 10" />
      </svg>
      <span className="token-usage-text">
        {compact(inputTokens)} in · {compact(outputTokens)} out
        {total !== undefined ? ` · ${compact(total)} total` : ''}
      </span>
    </span>
  );
}
