import { z } from 'zod';

/**
 * Pairing code: 8 uppercase letters A-Z, matched case sensitively.
 * See PROJECT.md (Pairing Flow) and ADR-014.
 */
export const pairingCodeSchema = z.string().regex(/^[A-Z]{8}$/);

/**
 * Approval number shown in both the browser and the terminal. Always 4 digits,
 * kept as a string so a leading zero is never lost.
 */
export const approvalNumberSchema = z.string().regex(/^[0-9]{4}$/);

export const deviceIdSchema = z.string().min(1);
export const sessionIdSchema = z.string().min(1);
export const requestIdSchema = z.string().min(1);
export const conversationIdSchema = z.string().min(1);

/** Identifies one prompt and the answer streaming back for it. */
export const turnIdSchema = z.string().min(1);

export type PairingCode = z.infer<typeof pairingCodeSchema>;
export type ApprovalNumber = z.infer<typeof approvalNumberSchema>;
export type DeviceId = z.infer<typeof deviceIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
