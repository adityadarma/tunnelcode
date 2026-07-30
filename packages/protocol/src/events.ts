import { z } from 'zod';
import {
  approvalNumberSchema,
  conversationIdSchema,
  deviceIdSchema,
  pairingCodeSchema,
  requestIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from './ids.js';

/**
 * Messages the CLI sends to the server.
 *
 * The CLI registers a code, then answers pairing requests. Only the CLI can
 * approve, so approval always travels in this direction. See ADR-014.
 */
export const cliMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register'),
    code: pairingCodeSchema,
    // Stable per machine, so a reconnect keeps existing sessions online.
    deviceId: deviceIdSchema,
    deviceName: z.string().min(1),
    // Recorded with the session so stored history says where it ran.
    workspace: z.string().min(1),
    engine: z.string().min(1),
    // Models the engine reported. The browser may only pick from this list, so
    // it can never ask for a model the chosen engine cannot serve.
    models: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal('approve'),
    requestId: requestIdSchema,
  }),
  z.object({
    type: z.literal('reject'),
    requestId: requestIdSchema,
  }),
  z.object({
    type: z.literal('ping'),
  }),
  // Engine output, forwarded as it arrives. Deltas are relayed but never stored.
  z.object({
    type: z.literal('delta'),
    turnId: turnIdSchema,
    text: z.string(),
  }),
  z.object({
    type: z.literal('turn_log'),
    turnId: turnIdSchema,
    text: z.string(),
  }),
  // Something the engine did rather than said: a file it wrote, a command it
  // ran. Reported separately from deltas so it never lands inside answer text.
  z.object({
    type: z.literal('turn_activity'),
    turnId: turnIdSchema,
    tool: z.string().min(1),
    // Absent when the engine did not say what the tool acted on.
    target: z.string().min(1).optional(),
  }),
  // The engine's own conversation id for this turn, stored so the next prompt in
  // this conversation can continue it and the agent keeps its context.
  z.object({
    type: z.literal('turn_session'),
    turnId: turnIdSchema,
    engineSessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('turn_done'),
    turnId: turnIdSchema,
    // Full answer assembled by the CLI, stored as one message. See ADR-008.
    text: z.string(),
  }),
  z.object({
    type: z.literal('turn_error'),
    turnId: turnIdSchema,
    message: z.string(),
    /**
     * Whatever the engine had already said before it failed.
     *
     * Sent so the part the user watched arrive is not lost on the next reload.
     * Optional because a turn can fail before saying anything, and because an
     * older CLI does not send it at all.
     */
    text: z.string().optional(),
  }),
]);

/**
 * Messages the server sends to the CLI.
 */
export const serverToCliMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('registered'),
    deviceId: deviceIdSchema,
  }),
  z.object({
    type: z.literal('pair_request'),
    requestId: requestIdSchema,
    approvalNumber: approvalNumberSchema,
  }),
  z.object({
    type: z.literal('paired'),
    deviceId: deviceIdSchema,
  }),
  // The session is over and the CLI should exit. Sent when the browser
  // disconnects, so the terminal does not keep waiting for a browser that left.
  z.object({
    type: z.literal('stop'),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    // True when retrying cannot help, so the CLI stops instead of reconnecting
    // and repeating the same failure. Optional so an older server still parses.
    fatal: z.boolean().optional(),
  }),
  // A prompt the browser asked for, routed to the engine on this machine.
  z.object({
    type: z.literal('prompt'),
    turnId: turnIdSchema,
    text: z.string().min(1),
    model: z.string().min(1).optional(),
    // Engine conversation to continue, recorded when an earlier turn in this
    // conversation reported one. Absent starts the engine fresh.
    resume: z.string().min(1).optional(),
  }),
]);

/**
 * Messages the browser sends to the server.
 *
 * The browser proves which session it owns once, when the socket opens. Every
 * later message is scoped to that session, so a prompt can never be routed to a
 * device the browser never paired with.
 */
export const browserMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    sessionId: sessionIdSchema,
  }),
  z.object({
    type: z.literal('prompt'),
    conversationId: conversationIdSchema,
    text: z.string().min(1),
    model: z.string().min(1).optional(),
  }),
  // The user ended the session from the browser. The agent runs on the paired
  // machine, so ending it has to reach the CLI, not just clear the browser.
  z.object({
    type: z.literal('disconnect'),
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);

/**
 * Messages the server sends to the browser.
 */
export const serverToBrowserMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attached'),
    sessionId: sessionIdSchema,
    online: z.boolean(),
    /**
     * The turn still being answered on this session, when there is one.
     *
     * A refresh closes the socket without ending the turn, so a browser that
     * attaches again has no other way to learn an answer is already on its way.
     * Without this it would offer a composer whose next prompt is certain to be
     * refused. Absent means nothing is running.
     */
    activeTurn: z
      .object({
        conversationId: conversationIdSchema,
        turnId: turnIdSchema,
      })
      .optional(),
  }),
  z.object({
    type: z.literal('device_status'),
    online: z.boolean(),
  }),
  // Echoed back so every browser on this session sees the prompt that was sent.
  z.object({
    type: z.literal('message'),
    conversationId: conversationIdSchema,
    id: z.string().min(1),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    /**
     * True when the answer was cut short by a failure. The browser marks it, so a
     * truncated reply is never mistaken for a finished one. Absent means complete.
     */
    partial: z.boolean().optional(),
    createdAt: z.number(),
  }),
  z.object({
    type: z.literal('delta'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    text: z.string(),
  }),
  // Relayed as it happens and also stored, so a refresh still shows what the
  // engine did during an earlier turn.
  z.object({
    type: z.literal('activity'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    id: z.string().min(1),
    tool: z.string().min(1),
    target: z.string().min(1).optional(),
    createdAt: z.number(),
  }),
  z.object({
    type: z.literal('turn_done'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);

export type CliMessage = z.infer<typeof cliMessageSchema>;
export type ServerToCliMessage = z.infer<typeof serverToCliMessageSchema>;
export type BrowserMessage = z.infer<typeof browserMessageSchema>;
export type ServerToBrowserMessage = z.infer<typeof serverToBrowserMessageSchema>;

/**
 * Parses an incoming WebSocket frame. Returns undefined for anything that is not
 * a valid message, so a malformed frame can never reach business logic.
 */
export function parseCliMessage(raw: string): CliMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = cliMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Parses a frame from the browser. Returns undefined for anything invalid, so a
 * malformed frame can never reach business logic.
 */
export function parseBrowserMessage(raw: string): BrowserMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const result = browserMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
