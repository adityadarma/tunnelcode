/**
 * When something last happened, said the way a person would say it.
 *
 * An agent session carries an ISO timestamp, and a timestamp is not an answer to the
 * question being asked of it. Someone scanning a list of sessions wants to know which
 * one they were in a moment ago, not the second it was written to disk. "2 hours ago"
 * answers that at a glance; "2026-02-11T09:14:03.221Z" makes the reader do the
 * subtraction themselves.
 *
 * Reads the clock itself rather than taking a "now" argument, because every caller
 * would pass `Date.now()` and one of them would eventually forget.
 */

/** How long each unit lasts, in milliseconds. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A month, taken as 30 days.
 *
 * Months are not a fixed length, and at this scale the difference does not survive
 * being rounded down to a whole number anyway: anything old enough to be counted in
 * months is old enough that the reader only wants the order of magnitude.
 */
const MONTH = 30 * DAY;

/** What to say when the timestamp is not a timestamp. */
const UNKNOWN = 'unknown';

/** `1 minute ago` rather than `1 minutes ago`. */
function ago(count: number, unit: string): string {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * How long ago `isoString` was, in words.
 *
 * Ranges, each rounded down to a whole unit: under a minute is "just now", then
 * minutes up to an hour, hours up to a day, days up to a month, and months beyond
 * that. Rounding down is what makes the boundaries read correctly — 119 seconds is
 * "1 minute ago", because it has not been two minutes yet.
 *
 * A timestamp in the future is reported as "just now" rather than counted backwards.
 * The browser's clock and the paired machine's clock are not the same clock, and a few
 * seconds of skew on a session that was just touched should not read as "in 3
 * seconds".
 *
 * An unparseable string yields "unknown". The alternative is arithmetic on `NaN`,
 * which renders as "NaN months ago" and looks like a crash to the reader; a session
 * with a broken timestamp is still worth showing.
 */
export function formatRelativeTime(isoString: string): string {
  const then = Date.parse(isoString);

  if (Number.isNaN(then)) {
    return UNKNOWN;
  }

  const elapsed = Date.now() - then;

  if (elapsed < MINUTE) {
    return 'just now';
  }

  if (elapsed < HOUR) {
    return ago(Math.floor(elapsed / MINUTE), 'minute');
  }

  if (elapsed < DAY) {
    return ago(Math.floor(elapsed / HOUR), 'hour');
  }

  if (elapsed < MONTH) {
    return ago(Math.floor(elapsed / DAY), 'day');
  }

  return ago(Math.floor(elapsed / MONTH), 'month');
}
