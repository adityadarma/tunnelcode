import { describe, expect, test } from 'vitest';
import { pairingCodeFromQr } from './pairing-code-from-qr.js';

describe('pairingCodeFromQr', () => {
  test('reads the code from the url the CLI encodes', () => {
    expect(pairingCodeFromQr('http://192.168.1.20:3000/login?code=ABCDEFGH')).toBe('ABCDEFGH');
  });

  test('accepts a bare code', () => {
    expect(pairingCodeFromQr('ABCDEFGH')).toBe('ABCDEFGH');
  });

  test('ignores surrounding whitespace', () => {
    expect(pairingCodeFromQr('  ABCDEFGH\n')).toBe('ABCDEFGH');
  });

  test('rejects a lowercase code rather than upper-casing it', () => {
    // Matching is case sensitive on the server, so a normalised guess would send
    // a code that cannot pair while looking like it should.
    expect(pairingCodeFromQr('abcdefgh')).toBeUndefined();
    expect(pairingCodeFromQr('http://localhost:3000/login?code=abcdefgh')).toBeUndefined();
  });

  test('rejects a code of the wrong length', () => {
    expect(pairingCodeFromQr('ABCDEFG')).toBeUndefined();
    expect(pairingCodeFromQr('ABCDEFGHI')).toBeUndefined();
  });

  test('rejects an unrelated qr payload', () => {
    expect(pairingCodeFromQr('https://example.com/')).toBeUndefined();
    expect(pairingCodeFromQr('WIFI:S:home;T:WPA;P:secret;;')).toBeUndefined();
  });
});
