interface TokenUsageProps {
  /**
   * Every input token the conversation has spent, the running turn included.
   *
   * The conversation's own figures rather than the last turn's: the pill answers what
   * this conversation has cost, and all three numbers on it now describe the same
   * thing. See ADR-060.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Whether a turn is still running, so these figures include one that has not been
   * charged yet.
   *
   * Only the wording depends on it, and the wording is where this belongs: the numbers
   * themselves are what the engine reported and are not decorated. A running turn
   * revises its counts as it goes, so presenting them as settled would hide that the
   * engine can still correct them. See ADR-055.
   */
  live?: boolean;
  /**
   * What the last turn to report spent, which stands for the context the conversation
   * now carries.
   *
   * Named in the tooltip rather than on the pill: it answers a different question from
   * the running total, and it is the one people ask second. Optional, because a
   * conversation from before this was stored has a total and no turn to report.
   */
  turnInputTokens?: number | undefined;
  turnOutputTokens?: number | undefined;
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
 * Displays what the conversation has spent, next to the model picker.
 *
 * Every figure on the pill is the conversation's: input, output, and the sum of the
 * two. It used to lead with the last turn's input and output and state the total
 * beside them, which put two different scopes in one line of three numbers and made
 * the total look like it did not add up. See ADR-060.
 *
 * The figures are held on the conversation rather than on the turn, so they survive a
 * refresh and a switch between conversations and stay on screen once a turn is over
 * instead of blinking out. A turn still running is counted in, revised as the engine
 * reports what it is spending, which is what `live` says. See ADR-055.
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
  turnInputTokens,
  turnOutputTokens,
  live = false,
}: TokenUsageProps): React.JSX.Element {
  const total = inputTokens + outputTokens;

  const title = [
    `Conversation — input: ${inputTokens.toLocaleString()} tokens · output: ${outputTokens.toLocaleString()} tokens · total: ${total.toLocaleString()} tokens`,
    'Every turn is counted, and each turn resends the conversation, so this is what was spent rather than how much context is in use.',
    ...(live
      ? [
          'A turn is still running, so it includes what that turn has spent so far and the engine may revise it when it finishes.',
        ]
      : []),
    // The last turn's input is roughly the context the conversation now carries, which
    // is a different question from what it has cost. Kept here rather than on the pill,
    // where it read as part of the total standing next to it.
    ...(turnInputTokens !== undefined && turnOutputTokens !== undefined
      ? [
          `${live ? 'This turn' : 'Last turn'} — input: ${turnInputTokens.toLocaleString()} tokens · output: ${turnOutputTokens.toLocaleString()} tokens`,
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
      {/* The total is always shown now: it is the sum of the two figures beside it
          rather than a separate scope that a conversation might not have one of. */}
      <span className="token-usage-text">
        {compact(inputTokens)} in · {compact(outputTokens)} out · {compact(total)} total
      </span>
    </span>
  );
}
