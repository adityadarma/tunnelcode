/**
 * Writes CLI output. Centralized so command modules never touch console
 * directly, which keeps the no-console lint rule enforceable.
 */
export function writeOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function writeErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Writes without a trailing newline, so streamed engine text reads as one
 * continuous answer instead of one line per fragment.
 */
export function writeRaw(text: string): void {
  process.stdout.write(text);
}
