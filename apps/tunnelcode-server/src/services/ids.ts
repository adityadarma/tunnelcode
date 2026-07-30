import { randomInt, randomUUID } from 'node:crypto';

const APPROVAL_DIGITS = 4;
const APPROVAL_MAX = 10 ** APPROVAL_DIGITS;

/**
 * Generates the 4 digit approval number shown in both the browser and the
 * terminal. Uses the crypto random source, not Math.random, because this value
 * guards pairing. Padded so a leading zero is never lost.
 */
export function generateApprovalNumber(): string {
  return String(randomInt(0, APPROVAL_MAX)).padStart(APPROVAL_DIGITS, '0');
}

export function generateId(): string {
  return randomUUID();
}
