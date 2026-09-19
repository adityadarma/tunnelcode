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
 * One model an engine can answer with.
 *
 * Two fields because the two jobs conflict. The id is what the engine takes back
 * and has to survive whole — Cursor's are parameterised, such as
 * `claude-opus-5[thinking=true,context=300k]`, and it accepts nothing shorter. The
 * label is what a person reads, and `default[]` is not a thing to show anybody when
 * the engine calls it `Auto`.
 *
 * A bare string is still accepted and read as a model labelled by its own id. That
 * is what every CLI before this change sent, and this field is required, so refusing
 * the old shape would stop an older CLI registering at all rather than degrading:
 * the device would simply show offline. The string form is normalised away here, so
 * nothing downstream has to know it existed. See ADR-051.
 */
export const engineModelSchema = z
  .union([
    z.string().min(1),
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    }),
  ])
  .transform((value) => (typeof value === 'string' ? { id: value, label: value } : value));

/** A model as every reader downstream of the schema sees it. */
export type EngineModelPayload = z.output<typeof engineModelSchema>;

/**
 * One engine a CLI can run, with the models it reported.
 *
 * Shared between `register` and `engines_updated`: the second is a later
 * revision of the same list the first sent, so the two must describe an engine
 * exactly the same way or a browser would have to read two shapes for one fact.
 */
const deviceEngineSchema = z
  .object({
    name: z.string().min(1),
    /**
     * The engine's own name for itself, as its vendor writes it.
     *
     * Optional so a CLI from before labels existed still registers, and filled
     * from the name when it is absent. Kept out of every comparison: a
     * conversation records the name, and that is what is matched.
     */
    label: z.string().min(1).optional(),
    models: z.array(engineModelSchema),
  })
  .transform((engine) => ({ ...engine, label: engine.label ?? engine.name }));

/** One engine a device reported, as every reader downstream of the schema sees it. */
export type DeviceEnginePayload = z.output<typeof deviceEngineSchema>;

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
 * Tokens spent, wherever a count travels.
 *
 * Shared so the CLI half and the browser half cannot drift, and so the running
 * total a conversation keeps is the same shape as the turn that adds to it.
 *
 * Zero is allowed because an engine is entitled to report it. What is not allowed
 * is inventing one: a count is absent when nobody reported it, and absent reads as
 * unknown rather than as free.
 */
const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

/** Tokens spent, as every reader downstream of the schema sees them. */
export type UsagePayload = z.output<typeof usageSchema>;

/**
 * Lightweight summary of a local agent session, used in list responses.
 */
const sessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  lastActiveAt: z.string().min(1),
  messageCount: z.number().int().min(0),
  preview: z.string().max(200),
});

/**
 * A message as read from an agent's local session file.
 */
const importedMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(ENGINE_TEXT_MAX_LENGTH),
});

/**
 * A tool call as read from an agent's local session file.
 */
const importedActivitySchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  target: z.string().nullable(),
  output: z.string().max(ENGINE_TEXT_MAX_LENGTH).nullable(),
});

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
    engines: z.array(deviceEngineSchema).min(1),
    /**
     * Version of the CLI process, so the browser can compare it with the server.
     *
     * Optional, so an older CLI that does not send it still registers. Absent reads
     * as unknown rather than as a version.
     */
    version: z.string().min(1).optional(),
    /**
     * How long a tool-run approval waits before being auto-refused, in milliseconds.
     *
     * Read from the CLI's tunnelcode.json (timeouts.answerMinutes). Optional, so an
     * older CLI that does not send it falls back to the server's default. See ADR-022.
     */
    answerTimeoutMs: z.number().positive().optional(),
  }),
  /**
   * A later revision of the engine list `register` already sent.
   *
   * `register` cannot wait for every engine's models before the code goes on
   * screen: listing them runs that engine's own CLI, which can cost several
   * seconds per engine, and the QR is the visible wait a person is looking at.
   * This carries the models that were still missing when `register` was sent,
   * so the browser learns them without the pairing screen ever holding for it.
   * The whole list is sent again rather than a diff, so a browser attaching
   * partway through discovery is never asked to merge two partial pictures. See
   * ADR-020.
   */
  z.object({
    type: z.literal('engines_updated'),
    engines: z.array(deviceEngineSchema).min(1),
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
   * What the running turn has spent so far.
   *
   * Carried on its own message rather than on a delta: the counts come from the
   * engine and arrive when it revises them, which has nothing to do with when a
   * fragment of text arrives, and an answer that streams for a minute without any
   * new count would have carried the same figure a thousand times.
   *
   * The whole of the turn's spend, never the difference since the last one, so a
   * reader replaces rather than adds. Nothing is stored from this: the conversation's
   * total is written once, from the figures on `turn_done`. See ADR-050 and ADR-055.
   */
  z.object({
    type: z.literal('turn_usage'),
    turnId: turnIdSchema,
    usage: usageSchema,
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
    usage: usageSchema.optional(),
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
    /**
     * What the turn spent before it failed.
     *
     * Reported for the same reason the partial answer is: the tokens were spent
     * whether or not an answer came of them, and a conversation total that skipped
     * every failed turn would understate what it cost. Optional, since a turn can
     * fail before any count arrives and an older CLI never sends one.
     */
    usage: usageSchema.optional(),
  }),
  /**
   * Git diff data from the local workspace, sent periodically by the CLI.
   *
   * Carries the output of `git status` and optionally the diff content for each
   * changed file. Not tied to a turn, because file changes happen independently
   * of the agent's work. See the file-changes page.
   */
  z.object({
    type: z.literal('file_changes'),
    files: z.array(
      z.object({
        /** Relative file path from workspace root. */
        path: z.string().min(1),
        /** Git status: M (modified), A (added), D (deleted), ? (untracked), etc. */
        status: z.string().min(1).max(4),
        /** Unified diff content for the file, when available. */
        diff: z.string().max(ENGINE_TEXT_MAX_LENGTH).optional(),
      }),
    ),
  }),
  /**
   * Response to a list_sessions_request, carrying summaries of local agent sessions.
   *
   * Sent after the CLI scans the engine's local storage. The sessions array is
   * capped at 100. An error field is present when the scan failed.
   */
  z.object({
    type: z.literal('list_sessions_response'),
    requestId: z.string().min(1),
    engine: z.string().min(1),
    sessions: z.array(sessionSummarySchema).max(100),
    /**
     * False when this engine cannot be scanned for local sessions at all.
     *
     * An empty list answers two different questions the same way, and the browser
     * owes the person a different sentence for each: an engine that keeps no local
     * history is not an engine that looked and found nothing, and offering "no
     * sessions yet" for the first invites them to go and make one. Reported rather
     * than inferred from a name, because whether a scan is possible depends on the
     * machine as much as the engine — the OpenCode reader needs a newer Node than
     * the CLI is guaranteed to be running under.
     *
     * Defaults to true, so a CLI from before this field still reads as supported.
     * That is the safe reading of silence: an older CLI only replied at all because
     * it had scanned, so its empty list really does mean nothing was found. Note
     * the default makes this required for everything that builds the message and
     * optional for everything that parses one, which is the asymmetry we want.
     */
    supported: z.boolean().default(true),
    error: z.string().optional(),
    /**
     * Why scanning is not possible, in words a person can act on.
     *
     * Carried alongside `supported: false` rather than folded into `error`, because
     * the two are not the same news: an error is a scan that went wrong and is worth
     * retrying, this is a scan that will never happen and retrying is a waste of the
     * user's tap. Absent when the engine is supported.
     */
    reason: z.string().optional(),
  }),
  /**
   * Response to an import_session_request, carrying the full content of a session.
   *
   * Sent after the CLI reads the session file. An error field is present when the
   * read failed, and the arrays are empty in that case.
   */
  z.object({
    type: z.literal('import_session_response'),
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    engineSessionId: z.string().nullable(),
    messages: z.array(importedMessageSchema),
    activities: z.array(importedActivitySchema),
    error: z.string().optional(),
  }),
]);

/**
 * Messages the server sends to the CLI.
 */
export const serverToCliMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('registered'),
    deviceId: deviceIdSchema,
    /**
     * How many live sessions this device already has on the server.
     *
     * Sent so the terminal knows whether anybody can come back before it decides
     * what to put on screen. A workspace with a live session has a browser holding
     * a cookie for it, and that browser resumes with a keypress rather than a scan,
     * so showing it a pairing code would be showing it something it has no use for.
     * See ADR-053.
     *
     * Optional because a CLI talking to an older server gets no answer, which reads
     * as none and shows the code, the behaviour that was there before.
     */
    resumableSessions: z.number().int().nonnegative().optional(),
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
  /**
   * Grants the permission Antigravity was refused and re-sends the last prompt.
   *
   * The CLI writes the rule to Antigravity's settings file, then starts a new turn
   * with the same prompt text. The turn id names the new turn, not the one that was
   * refused.
   */
  z.object({
    type: z.literal('grant_and_retry'),
    turnId: turnIdSchema,
    text: z.string().min(1).max(PROMPT_MAX_LENGTH),
    engine: z.string().min(1),
    model: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    /**
     * What to allow. Only writes, and only for the workspace the CLI is in.
     *
     * Running commands is deliberately not a value here. Antigravity cannot raise
     * an ask mid-turn, so an engine allowed to run commands would run them with
     * nobody able to see the question, and the rule that grant needs is
     * `command(*)` rather than anything scoped to a workspace. See ADR-031.
     */
    grant: z.literal('writes'),
  }),
  /**
   * Request a list of local agent sessions from the CLI.
   *
   * Sent when the browser wants to show available sessions for import. The CLI
   * scans the engine's local storage and responds with a list_sessions_response.
   */
  z.object({
    type: z.literal('list_sessions_request'),
    requestId: z.string().min(1),
    engine: z.string().min(1),
    cwd: z.string().min(1),
  }),
  /**
   * Request full content of a specific agent session for import.
   *
   * Sent when the browser confirms an import. The CLI reads the session file and
   * responds with an import_session_response containing all messages and activities.
   */
  z.object({
    type: z.literal('import_session_request'),
    requestId: z.string().min(1),
    engine: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
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
   * Turns autopilot on or off for one conversation.
   *
   * Named per conversation rather than per session because that is the whole of what
   * it grants: an ask raised in another conversation is still put to the user, even
   * while this one is answering its own. See ADR-059.
   *
   * Deliberately not a `permission_response` with a wider scope, and deliberately not
   * the `always` decision either: `always` writes a rule on the machine that outlives
   * every conversation on it, and this stops the moment it is switched off.
   */
  z.object({
    type: z.literal('set_autopilot'),
    conversationId: conversationIdSchema,
    enabled: z.boolean(),
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
  /**
   * Grants the permission Antigravity was refused, then retries the last prompt.
   *
   * Antigravity cannot ask mid-turn, so a block ends the work. This lets the user
   * grant from the browser and have the prompt re-sent without typing it again.
   * The grant kind says what to allow: 'writes' adds a workspace write rule,
   * Only writes can be granted this way, and only for the workspace the CLI is in.
   * Running commands is not offered here: the grant it needs is `command(*)`, which
   * is unscoped and would let an engine that cannot raise an ask run anything with
   * nobody able to see the question. That one stays a choice made in the terminal.
   * See ADR-031.
   */
  z.object({
    type: z.literal('grant_and_retry'),
    conversationId: conversationIdSchema,
    grant: z.literal('writes'),
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
  /**
   * A later revision of the engine list this session's device reported.
   *
   * Sent when the CLI finishes listing a model set that was still missing when
   * this browser attached, so the picker fills in without a reload. The whole
   * list travels again rather than a diff, for the same reason the CLI sends it
   * that way. See ADR-020.
   */
  z.object({
    type: z.literal('engines_updated'),
    engines: z.array(deviceEngineSchema).min(1),
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
   * What the turn on screen has spent so far, relayed as the engine reports it.
   *
   * Sent to every browser on the session, and not stored anywhere: a browser that
   * arrives mid-turn learns the figures from the next one of these, and what a turn
   * finally cost is written once, when it ends. See ADR-055.
   */
  z.object({
    type: z.literal('turn_usage'),
    conversationId: conversationIdSchema,
    turnId: turnIdSchema,
    usage: usageSchema,
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
    /**
     * True when autopilot answered rather than a person.
     *
     * Sent as a fact of its own rather than as a fifth outcome: what reached the
     * engine really was `once`, and a browser that has to undo its card reads the
     * outcome. This is what lets the surface say nobody was asked, so an approval
     * granted by a switch is never presented as one somebody made. Absent reads as
     * a decision a person took, which is what every older server sends.
     */
    auto: z.boolean().optional(),
  }),
  /**
   * Autopilot was switched for one conversation.
   *
   * Broadcast rather than answered only to the tab that asked, because two tabs on
   * one session would otherwise disagree about whether anybody is being asked. See
   * ADR-059.
   */
  z.object({
    type: z.literal('autopilot_changed'),
    conversationId: conversationIdSchema,
    enabled: z.boolean(),
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
    usage: usageSchema.optional(),
    /**
     * What the conversation has spent in total, this turn included.
     *
     * Sent beside the turn's own figures rather than instead of them, because the
     * two answer different questions and neither can be worked out from the other:
     * every turn resends the conversation, so the total is what it cost and the
     * turn's input is roughly how much context it now carries.
     *
     * Absent when no turn in this conversation has ever reported a count.
     */
    total: usageSchema.optional(),
  }),
  /**
   * Git file changes from the local workspace, forwarded from the CLI.
   *
   * Broadcast to all browsers on the session so the file-changes page can show
   * real-time workspace state without polling.
   */
  z.object({
    type: z.literal('file_changes'),
    files: z.array(
      z.object({
        path: z.string().min(1),
        status: z.string().min(1).max(4),
        diff: z.string().max(ENGINE_TEXT_MAX_LENGTH).optional(),
      }),
    ),
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
