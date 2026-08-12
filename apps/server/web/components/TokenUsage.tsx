interface TokenUsageProps {
  /** What the last turn to report spent, which stands for the context it carried. */
  inputTokens: number;
  outputTokens: number;
  /**
   * Whether the figures belong to a turn that is still running.
   *
   * Only the wording depends on it, and the wording is where this belongs: the numbers
   * themselves are what the engine reported and are not decorated. A running turn
   * revises its counts as it goes, so calling them the last turn's would name the
   * wrong turn, and presenting them as settled would hide that the engine can still
   * correct them. See ADR-055.
   */
  live?: boolean;
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
 * Displays what the turn spent, and what the conversation has spent in all, next to
 * the model picker.
 *
 * The figures are held on the conversation rather than on the turn, so they survive a
 * refresh and a switch between conversations and stay on screen once a turn is over
 * instead of blinking out. While a turn runs they are that turn's, revised as the
 * engine reports what it is spending, which is what `live` says. See ADR-055.
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
  live = false,
}: TokenUsageProps): React.JSX.Element {
  const total =
    totalInputTokens !== undefined && totalOutputTokens !== undefined
      ? totalInputTokens + totalOutputTokens
      : undefined;

  const title = [
    `${live ? 'This turn' : 'Last turn'} — input: ${inputTokens.toLocaleString()} tokens · output: ${outputTokens.toLocaleString()} tokens`,
    ...(live
      ? [
          'The turn is still running, so these are what it has spent so far and the engine may revise them when it finishes.',
        ]
      : []),
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
