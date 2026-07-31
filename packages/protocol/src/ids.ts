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

/**
 * Identifies one permission ask within its turn.
 *
 * Scoped to a turn rather than global, because an approval is the most dangerous
 * message in the protocol: the id alone must never be enough to allow a tool call
 * on someone else's machine. See ADR-022.
 */
export const permissionIdSchema = z.string().min(1);

/**
 * What a person decided about an ask.
 *
 * 'always' is a lasting grant for the device, recorded by TunnelCode rather than
 * by the engine that suggested it. See ADR-022.
 */
export const permissionDecisionSchema = z.enum(['once', 'always', 'reject']);

/**
 * How an ask ended, which includes the case where nobody answered.
 *
 * Kept apart from the decision because 'expired' is not something a person can
 * choose; it is what happens when the deadline passes and the ask is refused.
 */
export const permissionOutcomeSchema = z.enum(['once', 'always', 'reject', 'expired']);

export type PairingCode = z.infer<typeof pairingCodeSchema>;
export type ApprovalNumber = z.infer<typeof approvalNumberSchema>;
export type DeviceId = z.infer<typeof deviceIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type RequestId = z.infer<typeof requestIdSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type PermissionId = z.infer<typeof permissionIdSchema>;
export type PermissionDecision = z.infer<typeof permissionDecisionSchema>;
export type PermissionOutcome = z.infer<typeof permissionOutcomeSchema>;
