import { randomUUID } from 'node:crypto';
import type { ServerToCliMessage } from '@tunnelcode/protocol';
import type { ConversationRepository } from '../db/conversation-repository.js';
import type { TurnService } from '../services/turn.js';
import type { BrowserRegistry } from './browser-registry.js';

export interface TurnRelayOptions {
  turns: TurnService;
  browsers: BrowserRegistry;
  conversationRepository: ConversationRepository;
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

  /** Forwards a fragment of the answer as it arrives. */
  delta(deviceId: string, turnId: string, text: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return;
    }

    this.options.browsers.broadcast(turn.sessionId, {
      type: 'delta',
      conversationId: turn.conversationId,
      turnId,
      text,
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
    const turn = this.options.turns.findForDevice(turnId, deviceId);

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
    const turn = this.options.turns.findForDevice(turnId, deviceId);

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
    const turn = this.options.turns.findForDevice(turnId, deviceId);

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
   * Stores tool output when it arrives.
   */
  activityOutput(deviceId: string, turnId: string, activityId: string, output: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

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
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined || text === '') {
      return;
    }

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

  /**
   * Stores the finished answer and tells the browsers the turn is over.
   * An empty answer is not stored, since there is nothing to show later.
   */
  done(deviceId: string, turnId: string, text: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return;
    }

    this.options.turns.finish(turnId);

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
    });
  }

  /**
   * Reports a failed turn, keeping whatever the engine had already said.
   *
   * The partial answer is stored rather than dropped: the user watched it arrive,
   * and a reload that made it disappear looked like the work never happened. It
   * is stored as a partial so the transcript does not present it as a complete
   * reply. Nothing is stored when the turn failed before saying anything.
   */
  fail(deviceId: string, turnId: string, message: string, text?: string): void {
    const turn = this.options.turns.findForDevice(turnId, deviceId);

    if (turn === undefined) {
      return;
    }

    this.options.turns.finish(turnId);

    if (text !== undefined && text !== '') {
      const stored = this.options.conversationRepository.appendMessage(
        turn.conversationId,
        'assistant',
        text,
        true,
      );

      this.options.browsers.broadcast(turn.sessionId, {
        type: 'message',
        conversationId: turn.conversationId,
        id: stored.id,
        role: 'assistant',
        content: stored.content,
        partial: true,
        createdAt: stored.createdAt,
      });
    }

    this.options.browsers.broadcast(turn.sessionId, { type: 'error', message });
    this.options.browsers.broadcast(turn.sessionId, {
      type: 'turn_done',
      conversationId: turn.conversationId,
      turnId,
    });
  }

  /** Ends every turn owned by a device that disconnected. */
  abandonDevice(deviceId: string): void {
    for (const turn of this.options.turns.removeByDevice(deviceId)) {
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
