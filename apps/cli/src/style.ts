/**
 * ANSI terminal formatting helpers with zero dependencies.
 * Automatically disables color formatting when stdout is not a TTY or NO_COLOR is set.
 */

export const isColorSupported =
  process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';

export function bold(text: string): string {
  return isColorSupported ? `\u001b[1m${text}\u001b[22m` : text;
}

export function dim(text: string): string {
  return isColorSupported ? `\u001b[2m${text}\u001b[22m` : text;
}

export function cyan(text: string): string {
  return isColorSupported ? `\u001b[36m${text}\u001b[39m` : text;
}

export function cyanBold(text: string): string {
  return isColorSupported ? `\u001b[1;36m${text}\u001b[0m` : text;
}

export function green(text: string): string {
  return isColorSupported ? `\u001b[32m${text}\u001b[39m` : text;
}

export function greenBold(text: string): string {
  return isColorSupported ? `\u001b[1;32m${text}\u001b[0m` : text;
}

export function yellow(text: string): string {
  return isColorSupported ? `\u001b[33m${text}\u001b[39m` : text;
}

export function red(text: string): string {
  return isColorSupported ? `\u001b[31m${text}\u001b[39m` : text;
}
