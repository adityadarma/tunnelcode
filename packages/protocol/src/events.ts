import { z } from 'zod';
import {
  approvalNumberSchema,
  conversationIdSchema,
  deviceIdSchema,
  pairingCodeSchema,
  permissionDecisionSchema,
  permissionIdSchema,
  permissionOutcomeSchema,
  requestIdSchema,
  sessionIdSchema,
  turnIdSchema,
} from './ids.js';

/**
 * Longest prompt the browser may send.
 *
 * Generous for a question, including a pasted file, and far below anything worth
 * calling an upload. Enforced because everything a prompt carries is stored, and
 * the sender is the least trusted party in the system: the socket is reachable
 * before anything is proved, so an unbounded field is a way to write to the disk
 * of a machine the sender has no claim to. See ADR-030.
 */
export const PROMPT_MAX_LENGTH = 100_000;

/**
 * Longest single piece of engine output the CLI may report.
 *
 * Larger than a prompt because a command's output is not written by a person, and
 * smaller than what a command can actually produce, which is why the CLI shortens
 * before it sends rather than letting a message be refused: a refused frame would
 * be a turn that never finishes. See ADR-030.
 */
export const ENGINE_TEXT_MAX_LENGTH = 500_000;

/**
 * What an ask carries, wherever it travels.
 *
 * Shared between the CLI and the browser halves of the trip so the two cannot
 * drift: a field the CLI reports but the browser never learns about would leave
 * the person deciding with less than the engine offered.
 */
const permissionAskShape = {
  permissionId: permissionIdSchema,
  /** Tool as the engine named it. */
  tool: z.string().min(1),
  /** Label written for a person, rather than the raw tool name. */
  title: z.string().min(1),
  /** What the call would act on. Absent when the engine did not say. */
  target: z.string().min(1).optional(),
  /** Why the engine is asking, when it explains itself. */
  reason: z.string().min(1).optional(),
  /**
   * The concrete operations this one ask covers.
   *
   * A list because the engines do not agree on granularity: one asks per tool
   * call, the other can cover several commands at once. Showing only the first
   * would hide part of what is being agreed to.
   */
  details: z.array(z.string().min(1)),
  /**
   * Rules that would allow calls like this one without asking again, as worded by
   * the engine that raised the ask.
   *
   * Carried so a lasting grant can be recorded on the machine instead of in the
   * engine's own configuration. See ADR-022.
   */
  suggestions: z.array(z.string().min(1)),
};

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
    /**
     * Identifies this run of the CLI, generated once per process.
     *
     * Sent so the server can tell a run it has already been introduced to from a new
     * one, without remembering anything itself: the sessions a run approved carry the
     * hash of this, so a server that restarted reinstates them instead of asking the
     * terminal about a machine that never went anywhere. The code cannot serve this
     * purpose, because a code is only ever held in memory. Optional, so an older CLI
     * still registers and is treated as a run nobody recognises. See ADR-043.
     */
    runId: z.string().min(16).max(200).optional(),
    deviceName: z.string().min(1),
    // Recorded with the session so stored history says where it ran.
    workspace: z.string().min(1),
    /**
     * Engines that are both supported and installed on this machine, each with
     * the models it reported.
     *
     * A list rather than one name, because the engine is chosen per conversation
     * in the browser. Sending only what is installed is what stops the browser
     * offering an engine this machine cannot run. See ADR-020.
     */
    engines: z
      .array(
        z.object({
          name: z.string().min(1),
          models: z.array(z.string().min(1)),
        }),
      )
      .min(1),
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
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  /**
   * A fragment of the model working itself out, rather than of its answer.
   *
   * Carried on an event of its own so it can never land inside answer text: the
   * two arrive interleaved, and a reader who cannot tell them apart is reading
   * deliberation as though it had been said to them. Relayed and forgotten, like
   * an answer delta. See ADR-037.
   */
  z.object({
    type: z.literal('reasoning_delta'),
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  /**
   * A finished stretch of deliberation, assembled by the CLI and stored.
   *
   * Sent when the model stops thinking and does something else, which is the same
   * moment an answer is flushed for: it is the smallest unit that can be placed on
   * the timeline honestly. See ADR-024 and ADR-037.
   */
  z.object({
    type: z.literal('turn_reasoning'),
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  z.object({
    type: z.literal('turn_log'),
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  // Something the engine did rather than said: a file it wrote, a command it
  // ran. Reported separately from deltas so it never lands inside answer text.
  z.object({
    type: z.literal('turn_activity'),
    turnId: turnIdSchema,
    id: z.string().min(1),
    tool: z.string().min(1),
    // Absent when the engine did not say what the tool acted on.
    target: z.string().min(1).optional(),
  }),
  // A tool call the engine was not allowed to make. Reported separately from an
  // error because the turn carries on: without this the refusal is invisible and
  // the answer that follows has no visible cause.
  z.object({
    type: z.literal('turn_blocked'),
    turnId: turnIdSchema,
    tool: z.string().min(1),
    reason: z.string().min(1),
  }),
  /**
   * A tool call the engine will not make until someone allows it.
   *
   * Unlike turn_blocked this is not a verdict, it is a question: the turn stops
   * here until an answer comes back, so the server has to reach a browser with it.
   * See ADR-022.
   */
  z.object({
    type: z.literal('turn_permission_request'),
    turnId: turnIdSchema,
    ...permissionAskShape,
  }),
  // The engine's own conversation id for this turn, stored so the next prompt in
  // this conversation can continue it and the agent keeps its context.
  z.object({
    type: z.literal('turn_session'),
    turnId: turnIdSchema,
    engineSessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('turn_message'),
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  z.object({
    type: z.literal('turn_activity_output'),
    turnId: turnIdSchema,
    activityId: z.string().min(1),
    output: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  z.object({
    type: z.literal('turn_done'),
    turnId: turnIdSchema,
    // Full answer assembled by the CLI, stored as one message. See ADR-008.
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
    /**
     * Token usage for this turn, when the engine reported it.
     *
     * Optional because not every engine can report it. Absent means unknown,
     * not zero.
     */
    usage: z
      .object({
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('turn_error'),
    turnId: turnIdSchema,
    message: z.string().max(ENGINE_TEXT_MAX_LENGTH),
    /**
     * Whatever the engine had already said before it failed.
     *
     * Sent so the part the user watched arrive is not lost on the next reload.
     * Optional because a turn can fail before saying anything, and because an
     * older CLI does not send it at all.
     */
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH).optional(),
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
  /**
   * A browser holding a session from an earlier run wants to use it on this one.
   *
   * Separate from pair_request because it is a different question: no code was
   * presented, the browser already paired once, and what it is asking for is the
   * agent on a machine this process has not agreed to hand over yet. Answered with
   * the same approve and reject messages, so only the terminal can decide.
   * See ADR-040.
   */
  z.object({
    type: z.literal('resume_request'),
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
  /**
   * Kill the engine answering this turn.
   *
   * The server has already ended the turn on its side when this is sent, because an
   * engine that has stopped responding is exactly the case a stop button is for and
   * waiting for it to confirm would be waiting on the thing that is stuck. Nothing
   * the CLI reports for this turn afterwards is read. See ADR-042.
   */
  z.object({
    type: z.literal('stop_turn'),
    turnId: turnIdSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().max(ENGINE_TEXT_MAX_LENGTH),
    // True when retrying cannot help, so the CLI stops instead of reconnecting
    // and repeating the same failure. Optional so an older server still parses.
    fatal: z.boolean().optional(),
  }),
  // A prompt the browser asked for, routed to the engine on this machine.
  z.object({
    type: z.literal('prompt'),
    turnId: turnIdSchema,
    text: z.string().min(1).max(PROMPT_MAX_LENGTH),
    /**
     * Engine to answer with, taken from the conversation rather than from
     * configuration. Always one of the engines this CLI registered, so it can
     * always be run. See ADR-020.
     */
    engine: z.string().min(1),
    model: z.string().min(1).optional(),
    // Engine conversation to continue, recorded when an earlier turn in this
    // conversation reported one. Absent starts the engine fresh.
    resume: z.string().min(1).optional(),
  }),
  /**
   * The answer to an ask, on its way back to the engine that is waiting for it.
   *
   * Carries the turn as well as the ask, so an id on its own cannot decide
   * anything: the server only sends this for an ask it raised itself, and the CLI
   * only applies it to the turn it belongs to. See ADR-022.
   */
  z.object({
    type: z.literal('permission_response'),
    turnId: turnIdSchema,
    permissionId: permissionIdSchema,
    decision: permissionDecisionSchema,
    /**
     * True when the decision is a refusal because nobody answered in time.
     *
     * Sent as a fact rather than folded into the decision, so the CLI can say what
     * happened instead of reporting a timeout as something the user chose.
     * Optional, so an older server still parses.
     */
    expired: z.boolean().optional(),
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
  /**
   * A prompt for one conversation.
   *
   * The engine and the model are not sent: they belong to the conversation and
   * are read from it on the server, so two tabs cannot disagree about which
   * engine is answering. See ADR-020.
   */
  z.object({
    type: z.literal('prompt'),
    conversationId: conversationIdSchema,
    text: z.string().min(1).max(PROMPT_MAX_LENGTH),
  }),
  /**
   * What the user decided about an ask.
   *
   * The conversation travels with it so the server can refuse an answer aimed at
   * an ask this session does not own. The ask id alone is never enough: an
   * approval is the one message where a guessed id would run a tool call on a
   * machine the sender has no claim to. See ADR-022.
   */
  z.object({
    type: z.literal('permission_response'),
    conversationId: conversationIdSchema,
    permissionId: permissionIdSchema,
    decision: permissionDecisionSchema,
  }),
  /**
   * Stop the answer that is running.
   *
   * The turn is named rather than left implicit, so a stop that arrives just after
   * one answer ended cannot end the next one: a device answers one prompt at a
   * time, and without the id a late tap would land on whatever is running now.
   *
   * The conversation is not sent. The turn knows which one it belongs to, and the
   * server checks the turn belongs to the device this session paired with, which is
   * the same check a prompt goes through. See ADR-042.
   */
  z.object({
    type: z.literal('stop_turn'),
    turnId: turnIdSchema,
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
        /**
         * The answer so far, when the engine has already streamed part of it.
         *
         * Deltas are forwarded and forgotten, so a browser that was away while
         * they arrived has nothing to show and used to wait on a blank indicator
         * until the turn ended. Sent here rather than as replayed deltas, because
         * a browser that has just attached does not yet know which conversation
         * it is showing and would drop them. Absent when nothing has been
         * streamed yet. See ADR-032.
         */
        pendingText: z.string().max(ENGINE_TEXT_MAX_LENGTH).optional(),
      })
      .optional(),
  }),
  /**
   * The session is real but this CLI run has not agreed to it yet.
   *
   * Sent instead of `attached`, so a browser that survived a restart of the CLI
   * cannot act on the machine before the terminal says so. The number is shown so
   * the person at the keyboard can check it against what the terminal is asking.
   * See ADR-040.
   */
  z.object({
    type: z.literal('resume_pending'),
    sessionId: sessionIdSchema,
    approvalNumber: approvalNumberSchema,
  }),
  /**
   * The terminal agreed. The browser attaches again rather than being handed an
   * `attached` here, because attaching is what reports a running turn and replays
   * a waiting ask, and one path for that is easier to trust than two.
   */
  z.object({
    type: z.literal('resume_approved'),
    sessionId: sessionIdSchema,
  }),
  /**
   * The terminal refused, which retires the session rather than merely declining
   * this connection: a refusal is the answer to "should this browser still have my
   * machine", and it has to mean no from now on.
   */
  z.object({
    type: z.literal('resume_rejected'),
    message: z.string().min(1),
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
    content: z.string().max(ENGINE_TEXT_MAX_LENGTH),
    /**
     * True when the answer was cut short. The browser marks it, so a truncated
     * reply is never mistaken for a finished one. Absent means complete.
     */
    partial: z.boolean().optional(),
    /**
     * Why it was cut short, when that is known.
     *
     * `stopped` is the user asking for it, `failed` is everything else. Sent so the
     * transcript can say which of the two happened instead of describing a stop the
     * user chose as something that went wrong. Absent on a complete answer, and on a
     * partial one stored before this existed. See ADR-042.
     */
    interruption: z.enum(['stopped', 'failed']).optional(),
    createdAt: z.number(),
  }),
  /**
   * A turn has begun, sent as soon as the prompt is accepted.
   *
   * The browser used to learn a turn's id from its first fragment of output, which
   * is no help for the turn that most needs stopping: one whose engine says nothing
   * at all. Every browser on the session gets it, so a second tab shows an answer on
   * the way rather than a composer that will refuse the next prompt. See ADR-042.
   */
  z.object({
    type: z.literal('turn_started'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
  }),
  z.object({
    type: z.literal('delta'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  /**
   * Thinking as it arrives, kept apart from the answer all the way to the surface.
   *
   * Not stored: this is the same text the turn stores once, as a reasoning record,
   * when the model stops thinking. See ADR-037.
   */
  z.object({
    type: z.literal('reasoning_delta'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    text: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  /**
   * A stored stretch of deliberation, placed on the timeline like an activity.
   *
   * Relayed as well as stored, so the block a reader watched arrive is the same
   * block that comes back after a refresh.
   */
  z.object({
    type: z.literal('reasoning'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    id: z.string().min(1),
    content: z.string().max(ENGINE_TEXT_MAX_LENGTH),
    createdAt: z.number(),
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
    /**
     * True when the engine was not allowed to make this call, so it never
     * happened. Absent means the tool ran.
     */
    blocked: z.boolean().optional(),
    /** Why the call was refused, present only on a blocked one. */
    reason: z.string().min(1).optional(),
    createdAt: z.number(),
  }),
  z.object({
    type: z.literal('activity_output'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    activityId: z.string().min(1),
    output: z.string().max(ENGINE_TEXT_MAX_LENGTH),
  }),
  /**
   * An ask waiting for an answer.
   *
   * Sent to every browser on the session, and also replayed on attach, because a
   * phone that locked mid-turn is the normal case rather than the exception: the
   * engine is holding still until this is answered.
   */
  z.object({
    type: z.literal('permission_request'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    ...permissionAskShape,
    createdAt: z.number(),
    /**
     * When the ask stops being answerable, decided by the server so every browser
     * agrees.
     *
     * Sent rather than computed per tab, so two phones cannot show two different
     * countdowns for the same ask, and a card that is already dead is not offered
     * as though it were live.
     */
    expiresAt: z.number(),
  }),
  /**
   * An ask that is no longer waiting, so its card can go away.
   *
   * Needed because two browsers can be attached at once: without it, the tab that
   * did not answer would keep offering a decision that has already been made. It
   * also covers the ask nobody answered, which ends as 'expired'.
   */
  z.object({
    type: z.literal('permission_resolved'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    permissionId: permissionIdSchema,
    outcome: permissionOutcomeSchema,
  }),
  z.object({
    type: z.literal('turn_done'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    /**
     * Token usage for this turn, when the engine reported it.
     *
     * Optional because not every engine reports it. Absent means unknown.
     */
    usage: z
      .object({
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('pong'),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().max(ENGINE_TEXT_MAX_LENGTH),
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
