const CODE_PATTERN = /^[A-Z]{8}$/;

/**
 * Reads the pairing code out of a scanned QR payload.
 *
 * The CLI encodes a login URL carrying the code in the query string, but a code
 * typed into another QR generator arrives bare, so both shapes are accepted.
 * Anything else returns undefined rather than being coerced: matching is case
 * sensitive, so a normalised guess would pair the wrong thing or nothing at all.
 */
export function pairingCodeFromQr(payload: string): string | undefined {
  const text = payload.trim();

  if (CODE_PATTERN.test(text)) {
    return text;
  }

  try {
    const code = new URL(text).searchParams.get('code');
    return code !== null && CODE_PATTERN.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
