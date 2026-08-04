interface TokenUsageProps {
  inputTokens: number;
  outputTokens: number;
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
 * Displays token usage from the last turn, next to the model picker.
 *
 * Shown as a compact pill so it occupies no more space than the model name beside
 * it. Absent when the engine did not report usage, which keeps the toolbar clean
 * for engines that cannot count.
 */
export function TokenUsage({ inputTokens, outputTokens }: TokenUsageProps): React.JSX.Element {
  return (
    <span
      className="token-usage"
      title={`Input: ${inputTokens.toLocaleString()} tokens · Output: ${outputTokens.toLocaleString()} tokens`}
    >
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
      </span>
    </span>
  );
}
