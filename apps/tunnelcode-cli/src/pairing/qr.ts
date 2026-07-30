import { toString as qrToString } from 'qrcode';

/**
 * Renders a QR code as terminal text. Small enough to scan from a phone while
 * still fitting a normal terminal width.
 */
export async function renderQr(text: string): Promise<string> {
  return qrToString(text, { type: 'terminal', small: true });
}
