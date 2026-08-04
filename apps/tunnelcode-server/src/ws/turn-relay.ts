import { randomUUID } from 'node:crypto';
import type { PermissionDecision, ServerToCliMessage } from '@tunnelcode/protocol';
import type { ConversationRepository, Interruption } from '../db/conversation-repository.js';
import type { SessionRepository } from '../db/session-repository.js';
import type { PendingPermission, PermissionService } from '../services/permission.js';
import type { Notification } from '../services/push.js';
import type { Turn, TurnService } from '../services/turn.js';
import type { BrowserRegistry } from './browser-registry.js';
import type { CliRegistry } from './registry.js';

/** What the CLI reported about a tool call it is waiting to be allowed to make. */
export interface PermissionAsk {
  permissionId: string;
  tool: string;
  title: string;
  target?: string;
  reason?: string;
  details: string[];
  suggestions: string[];
}

export interface TurnRelayOptions {
  turns: TurnService;
  browsers: BrowserRegistry;
  conversationRepository: ConversationRepository;
  sessionRepository: SessionRepository;
  permissions: PermissionService;
  /** Needed because an answer has to travel back to the waiting engine. */
  registry: CliRegistry;
  /**
   * Reaches a browser that is not connected.
   *
   * Optional because the relay's job is the turn, not the notification: a server
   * built without one simply tells nobody. It decides for itself whether anybody
   * needs telling. See ADR-045.
   */
  push?: PushNotifier;
}

/** The part of the push service the relay uses, kept narrow on purpose. */
export interface PushNotifier {
  notify(sessionId: string, notification: Notification): void;
}

/**
 * Relays engine output from a CLI to the browsers watching that session.
 *
 * Deltas are forwarded and immediately forgotten. Only the assembled answer is
 * stored, once, when the turn finishes, which keeps writes proportional to
 * messages instead of tokens. See ADR-008.
 */
export class TurnRelay {
  constructor(private readonly options: TurnRelayOptions) {}

  /**
   * The turn a report belongs to, counting the report as session activity.
   *
   * A turn that keeps reporting is the session being used, so the idle timeout
   * must not run out underneath it. Deltas deliberately do not come through here:
   * they arrive many times a second, and writing on each one would put token-rate
   * traffic into the database that ADR-008 keeps out of it. Everything routed here
   * already writes a row of its own, so the extra update stays proportional to
   * what the turn did. See ADR-026.
   */
  private activeTurn(deviceId: string, turnId: string): Turn | undefined {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn !== undefined) {
      this.options.sessionRepository.touch(turn.sessionId);
    }

    return turn;
  }

  /** Forwards a fragment of the answer as it arrives. */
  delta(deviceId: string, turnId: string, text: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return;
    }

    // Kept in memory as well as forwarded, so a browser that arrives later in the
    // same turn is given what it missed instead of an empty indicator. Nothing is
    // written here: this is the text the turn stores once, when it flushes or
    // finishes. See ADR-032.
    this.options.turns.appendText(turnId, text);

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'delta',
      conversationId: turn.conversationId,
      turnId,
      text,
    });
  }

  /**
   * Forwards a fragment of the model's thinking.
   *
   * Nothing is stored and nothing is buffered: the CLI holds the thought and sends
   * it whole when the model stops thinking, so this is only what a browser watching
   * right now gets to see. A browser that attaches mid-thought therefore misses the
   * fragments and is given the stored block instead, which is the same trade the
   * transcript already makes for tool output. See ADR-037.
   */
  reasoningDelta(deviceId: string, turnId: string, text: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return;
    }

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'reasoning_delta',
      conversationId: turn.conversationId,
      turnId,
      text,
    });
  }

  /**
   * Stores a finished stretch of thinking and forwards it.
   *
   * Placed on the timeline as its own record rather than folded into the answer,
   * because the two are different kinds of thing and the reader decides which of
   * them to read. An empty one is nothing to fold open, so it is dropped.
   */
  reasoning(deviceId: string, turnId: string, text: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined || text === '') {
      return;
    }

    const stored = this.options.conversationRepository.appendReasoning(turn.conversationId, text);

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'reasoning',
      conversationId: turn.conversationId,
      turnId,
      id: stored.id,
      content: stored.content,
      createdAt: stored.createdAt,
    });
  }

  /**
   * Records the engine conversation behind this turn, so the next prompt in the
   * same conversation continues it.
   *
   * Nothing is sent to the browser: the id is only meaningful to the engine that
   * issued it, and it is not part of the transcript the user reads.
   */
  engineSession(deviceId: string, turnId: string, engineSessionId: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    // The engine comes from the turn, since that is what knows which engine the
    // prompt was sent to.
    this.options.conversationRepository.setEngineSession(
      turn.conversationId,
      engineSessionId,
      turn.engine,
    );
  }

  /**
   * Stores something the engine did and forwards it.
   *
   * Written as it arrives rather than at the end of the turn: an activity is
   * already complete when reported, and a turn that fails halfway should still
   * show what it changed before failing.
   */
  activity(
    deviceId: string,
    turnId: string,
    id: string,
    tool: string,
    target: string | undefined,
  ): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    const stored = this.options.conversationRepository.appendActivity(
      turn.conversationId,
      id,
      tool,
      target,
    );

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'activity',
      conversationId: turn.conversationId,
      turnId,
      id: stored.id,
      tool: stored.tool,
      ...(stored.target !== null ? { target: stored.target } : {}),
      createdAt: stored.createdAt,
    });
  }

  /**
   * Stores a tool call the engine was not allowed to make.
   *
   * Recorded as an activity rather than an error: the turn carries on, and the
   * refusal is part of what the turn attempted. Nothing else reports it, so
   * without this the answer that follows has no visible cause.
   */
  blocked(deviceId: string, turnId: string, tool: string, reason: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    // The id is minted here rather than taken from the engine: a refusal is
    // reported without one, because no tool call was ever made to identify. It
    // still needs an id of its own so the activity has a stable key, and so a
    // second refusal of the same tool is not mistaken for the first.
    //
    // The refused call carries no target: what matters is which tool was stopped
    // and why, and the reason already names what it tried to touch.
    const stored = this.options.conversationRepository.appendActivity(
      turn.conversationId,
      randomUUID(),
      tool,
      undefined,
      { reason },
    );

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'activity',
      conversationId: turn.conversationId,
      turnId,
      id: stored.id,
      tool: stored.tool,
      blocked: true,
      ...(stored.reason !== null ? { reason: stored.reason } : {}),
      createdAt: stored.createdAt,
    });
  }

  /**
   * Records a tool call the engine is waiting to be allowed to make, and puts it
   * in front of every browser on the session.
   *
   * Nothing is written to the database: an ask cannot outlive the in-memory turn
   * it belongs to, so a stored row could never be read back usefully. What does
   * get stored is the outcome, and only when the call is refused, which the CLI
   * reports as a blocked activity of its own. See ADR-022.
   */
  permissionRequest(deviceId: string, turnId: string, ask: PermissionAsk): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    const pending = this.options.permissions.add(
      {
        id: ask.permissionId,
        turnId,
        sessionId: turn.sessionId,
        deviceId,
        conversationId: turn.conversationId,
        tool: ask.tool,
        title: ask.title,
        ...(ask.target !== undefined ? { target: ask.target } : {}),
        ...(ask.reason !== undefined ? { reason: ask.reason } : {}),
        details: ask.details,
        suggestions: ask.suggestions,
      },
      (expired) => {
        // Nobody saw it. Refusing is the only safe reading of a dark screen, and
        // the turn carries on with an answer that explains what it could not do.
        this.answerEngine(expired, 'reject', true);
        this.announceResolved(expired, 'expired');
      },
    );

    this.options.browsers.broadcast(turn.sessionId, this.askMessage(pending));

    // The one event in a turn that cannot proceed without the user, and it expires.
    // A browser that is closed would otherwise leave the agent stopped until the ask
    // timed out, with nothing anywhere to say it was waiting. See ADR-045.
    this.notify(turn.sessionId, {
      kind: 'permission',
      title: 'Approval needed',
      body: ask.target === undefined ? ask.title : `${ask.title}: ${ask.target}`,
      conversationId: turn.conversationId,
    });
  }

  /**
   * Tells a browser that is not connected, if anything is set up to.
   *
   * The push service decides whether anybody needs telling, since it is what knows
   * about subscriptions; the relay only says what happened.
   */
  private notify(sessionId: string, notification: Notification): void {
    this.options.push?.notify(sessionId, notification);
  }

  /**
   * Applies a decision a browser made.
   *
   * Returns false when the session has no such ask waiting, which is what an
   * answer aimed at another session's ask looks like from here.
   */
  decidePermission(
    sessionId: string,
    conversationId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): boolean {
    const pending = this.options.permissions.find(sessionId, conversationId, permissionId);

    if (pending === undefined) {
      return false;
    }

    // Taken out of the waiting set first, so two phones answering at once cannot
    // both reach the engine.
    if (this.options.permissions.resolve(pending.turnId, pending.id) === undefined) {
      return false;
    }

    // Answering an ask is the user working, and it is the one moment in a turn
    // that only they can move. A session must not go idle underneath the person
    // deciding whether to allow something.
    this.options.sessionRepository.touch(pending.sessionId);

    this.answerEngine(pending, decision);
    this.announceResolved(pending, decision);

    return true;
  }

  /** The ask as a browser receives it, used for both broadcast and replay. */
  askMessage(
    pending: PendingPermission,
  ): Extract<Parameters<BrowserRegistry['broadcast']>[1], { type: 'permission_request' }> {
    return {
      type: 'permission_request',
      conversationId: pending.conversationId,
      turnId: pending.turnId,
      permissionId: pending.id,
      tool: pending.tool,
      title: pending.title,
      ...(pending.target !== undefined ? { target: pending.target } : {}),
      ...(pending.reason !== undefined ? { reason: pending.reason } : {}),
      details: pending.details,
      suggestions: pending.suggestions,
      createdAt: pending.createdAt,
      expiresAt: pending.expiresAt,
    };
  }

  private answerEngine(
    pending: PendingPermission,
    decision: PermissionDecision,
    expired = false,
  ): void {
    this.options.registry.send(pending.deviceId, {
      type: 'permission_response',
      turnId: pending.turnId,
      permissionId: pending.id,
      decision,
      // Said only when true, so a refusal the user chose is never dressed up as a
      // timeout on the machine that reports it.
      ...(expired ? { expired: true } : {}),
    });
  }

  /**
   * Tells every browser the ask is no longer waiting.
   *
   * Two tabs can be attached to one session, so the one that did not answer would
   * otherwise keep offering a decision that has already been made.
   */
  private announceResolved(
    pending: PendingPermission,
    outcome: PermissionDecision | 'expired',
  ): void {
    this.options.browsers.broadcast(pending.sessionId, {
      type: 'permission_resolved',
      conversationId: pending.conversationId,
      turnId: pending.turnId,
      permissionId: pending.id,
      outcome,
    });
  }

  /**
   * Clears asks that can no longer be answered, because the turn waiting on them
   * is over.
   */
  private dropPermissions(pending: readonly PendingPermission[]): void {
    for (const ask of pending) {
      this.announceResolved(ask, 'expired');
    }
  }

  /**
   * Stores tool output when it arrives.
   */
  activityOutput(deviceId: string, turnId: string, activityId: string, output: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    this.options.conversationRepository.updateActivityOutput(activityId, output);

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'activity_output',
      conversationId: turn.conversationId,
      turnId,
      activityId,
      output,
    });
  }

  /**
   * Stores an intermediate chunk of the answer and broadcasts it.
   * Called when the engine pauses streaming text to execute a tool.
   */
  message(deviceId: string, turnId: string, text: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined || text === '') {
      return;
    }

    const stored = this.options.conversationRepository.appendMessage(
      turn.conversationId,
      'assistant',
      text,
    );

    // The transcript carries this text now, so the buffer must let go of it: a
    // reattaching browser would otherwise read it from both places and show it
    // twice.
    this.options.turns.clearText(turnId);

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'message',
      conversationId: turn.conversationId,
      id: stored.id,
      role: 'assistant',
      content: stored.content,
      createdAt: stored.createdAt,
    });
  }

  /**
   * Stores the finished answer and tells the browsers the turn is over.
   * An empty answer is not stored, since there is nothing to show later.
   */
  done(
    deviceId: string,
    turnId: string,
    text: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    this.options.turns.finish(turnId);
    // An ask the engine no longer waits on cannot be answered, so its card has to
    // stop offering a decision that would go nowhere.
    this.dropPermissions(this.options.permissions.removeByTurn(turnId));

    if (text !== '') {
      const stored = this.options.conversationRepository.appendMessage(
        turn.conversationId,
        'assistant',
        text,
      );

      this.options.browsers.broadcast(turn.sessionId, {
        type: 'message',
        conversationId: turn.conversationId,
        id: stored.id,
        role: 'assistant',
        content: stored.content,
        createdAt: stored.createdAt,
      });
    }

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'turn_done',
      conversationId: turn.conversationId,
      turnId,
      ...(usage !== undefined ? { usage } : {}),
    });

    // A turn is the long wait: the user asked for something and went away. The answer
    // itself is the body, since that is what they came back for.
    this.notify(turn.sessionId, {
      kind: 'done',
      title: 'The answer is ready',
      body: text === '' ? 'The agent finished working.' : text,
      conversationId: turn.conversationId,
    });
  }

  /**
   * Records that a turn ended without a complete answer, and forwards the record.
   *
   * Stored even when nothing was said, which is the part that used to be lost: the
   * error naming the cause is broadcast and gone, so a browser that was away came
   * back to a prompt with no reply and nothing to say why. An empty partial is what
   * the transcript shows as an answer that stopped, and the surface already says so
   * in words. See ADR-033.
   */
  private storeInterruption(
    conversationId: string,
    sessionId: string,
    text: string,
    /**
     * Why it ended short. Carried into the record so the transcript can say the user
     * stopped it rather than describing their own tap as a failure. See ADR-042.
     */
    interruption: Interruption,
  ): void {
    const stored = this.options.conversationRepository.appendMessage(
      conversationId,
      'assistant',
      text,
      interruption,
    );

    this.options.browsers.broadcast(sessionId, {
      type: 'message',
      conversationId,
      id: stored.id,
      role: 'assistant',
      content: stored.content,
      partial: true,
      interruption,
      createdAt: stored.createdAt,
    });
  }

  /**
   * Ends a turn because the user asked it to stop.
   *
   * The turn is finished here first and the CLI is only told afterwards, which is the
   * opposite of how the rest of a turn works. It has to be: an engine that is wedged
   * is the case this exists for, and waiting for it to confirm would be waiting on
   * the thing that is stuck. Whatever the CLI reports for this turn afterwards is
   * dropped, because a turn nothing knows about is already ignored everywhere.
   *
   * Returns false when there is no such turn on this device, which is what a second
   * tap looks like from here. See ADR-042.
   */
  stop(deviceId: string, turnId: string): boolean {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return false;
    }

    // Sent whether or not the machine is reachable. An unreachable one is a no-op,
    // and the turn still has to be released: a session whose device vanished mid
    // answer would otherwise refuse every prompt that followed.
    this.options.registry.send(deviceId, { type: 'stop_turn', turnId });

    // Read before finishing, since finishing forgets the buffer.
    const said = this.options.turns.textOf(turnId);

    this.options.turns.finish(turnId);

    // The engine is being killed, so an ask it was holding still for can never be
    // answered. Cleared before the turn ends, or a card would outlive its turn.
    this.dropPermissions(this.options.permissions.removeByTurn(turnId));

    // What the model had already said is kept, marked as stopped. No error is
    // broadcast: a stop is not a fault, and the record on the timeline is what says
    // it happened, which is also what a browser that was away comes back to.
    this.storeInterruption(turn.conversationId, turn.sessionId, said, 'stopped');

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'turn_done',
      conversationId: turn.conversationId,
      turnId,
    });

    return true;
  }

  /**
   * Reports a failed turn, keeping whatever the engine had already said.
   *
   * The partial answer is stored rather than dropped: the user watched it arrive,
   * and a reload that made it disappear looked like the work never happened. It
   * is stored as a partial so the transcript does not present it as a complete
   * reply.
   */
  fail(deviceId: string, turnId: string, message: string, text?: string): void {
    const turn = this.activeTurn(deviceId, turnId);

    if (turn === undefined) {
      return;
    }

    // What the CLI reported is preferred, since it assembled the answer, and the
    // streamed buffer stands in when a failure arrived without any text. Read
    // before the turn is finished, because finishing forgets the buffer.
    const said = text !== undefined && text !== '' ? text : this.options.turns.textOf(turnId);

    this.options.turns.finish(turnId);
    this.dropPermissions(this.options.permissions.removeByTurn(turnId));

    this.storeInterruption(turn.conversationId, turn.sessionId, said, 'failed');

    this.options.browsers.broadcast(turn.sessionId, { type: 'error', message });
    this.options.browsers.broadcast(turn.sessionId, {
      type: 'turn_done',
      conversationId: turn.conversationId,
      turnId,
    });

    // Told as well as a finished answer, because the wait ended either way and coming
    // back to nothing is what a silent failure looks like from the outside.
    this.notify(turn.sessionId, {
      kind: 'failed',
      title: 'The answer stopped',
      body: message,
      conversationId: turn.conversationId,
    });
  }

  /** Ends every turn owned by a device that disconnected. */
  abandonDevice(deviceId: string): void {
    // The engine that raised these is gone, so nothing is left to answer. Told to
    // the browsers first, because the turn_done that follows would otherwise leave
    // an approval card behind with no turn to belong to.
    this.dropPermissions(this.options.permissions.removeByDevice(deviceId));

    for (const turn of this.options.turns.removeByDevice(deviceId)) {
      // The machine that was answering is gone, so nothing else will ever report
      // this turn. Written to the transcript for that reason: the error below is
      // seen only by a browser that happens to be attached, and this is the one
      // interruption nobody can ask about afterwards. See ADR-033.
      this.storeInterruption(turn.conversationId, turn.sessionId, turn.pendingText, 'failed');

      this.options.browsers.broadcast(turn.sessionId, {
        type: 'error',
        message: 'The device went offline before the answer finished.',
      });
      this.options.browsers.broadcast(turn.sessionId, {
        type: 'turn_done',
        conversationId: turn.conversationId,
        turnId: turn.id,
      });
    }
  }

  /** Tells browsers whether the device behind their session is reachable. */
  status(sessionIds: readonly string[], online: boolean): void {
    for (const sessionId of sessionIds) {
      this.options.browsers.broadcast(sessionId, { type: 'device_status', online });
    }
  }
}

export type CliReply = (message: ServerToCliMessage) => void;
