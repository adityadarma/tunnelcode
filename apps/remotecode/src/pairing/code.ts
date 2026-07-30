import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LENGTH = 8;

/**
 * Generates a pairing code of 8 uppercase letters.
 *
 * Uses the crypto random source, not Math.random, because this code is the only
 * thing standing between a stranger and a pairing request. See ADR-014.
 */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET.charAt(randomInt(0, ALPHABET.length));
  }
  return code;
}

/**
 * Builds the URL encoded in the QR code. The code travels in the query string,
 * which is why pairing also needs the approval number the server generates.
 */
export function buildLoginUrl(serverUrl: string, code: string): string {
  const url = new URL('/login', serverUrl);
  url.searchParams.set('code', code);
  return url.toString();
}

/**
 * Converts an http(s) server URL into the matching WebSocket URL, so the CLI
 * and the browser always agree on host and port.
 */
export function buildCliSocketUrl(serverUrl: string): string {
  const url = new URL('/ws/cli', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
