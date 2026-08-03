import type { Engine, EnginePermissionDecision, EnginePermissionRequest } from '@tunnelcode/engine';
import { ENGINE_TEXT_MAX_LENGTH } from '@tunnelcode/protocol';
import type { CliMessage } from '@tunnelcode/protocol';
import type { PermissionPolicy } from './permission-policy.js';

/**
 * Shortens anything too long to send, keeping the beginning and saying what was
 * dropped.
 *
 * A command can print more than the protocol accepts, and the protocol has to
 * refuse an unbounded field because everything it carries is stored. Shortened
 * here rather than refused there: a message the server rejects is a turn that
 * never reports finishing, which leaves the browser waiting forever for an answer
 * that already arrived. Saying how much was cut is what keeps it honest, so nobody
 * reads a trimmed log as the whole of it. See ADR-030.
 */
function clamp(text: string): string {
  if (text.length <= ENGINE_TEXT_MAX_LENGTH) {
    return text;
  }

  const note = `\n\n[${String(text.length - ENGINE_TEXT_MAX_LENGTH)} more characters were not sent.]`;

  return `${text.slice(0, ENGINE_TEXT_MAX_LENGTH - note.length)}${note}`;
}

/**
 * How long the engine may produce nothing at all before the turn is abandoned.
 *
 * Measured between events rather than over the whole turn: a long task that keeps
 * streaming is working as intended, while one that has said nothing for this long
 * is not coming back. Without a limit an engine that hangs holds the device
 * forever, because a device answers one prompt at a time.
 */
const SILENCE_TIMEOUT_MS = 5 * 60 * 1000;

export interface PromptRunnerOptions {
  /**
   * Engines available on this machine, by name.
   *
   * A map rather than one engine, because the engine is chosen per conversation
   * and every turn names the one it needs. See ADR-020.
   */
  engines: Map<string, Engine>;
  cwd: string;
  send: (message: CliMessage) => void;
  /** Called on conversation activity, which is what resets the idle timeout. */
  onActivity: () => void;
  /**
   * What this machine already knows about a tool call, consulted before anyone is
   * asked. Absent asks about everything, which is what tests want.
   */
  policy?: PermissionPolicy;
  /** Overridden in tests, which cannot wait minutes for a real timeout. */
  silenceTimeoutMs?: number;
}

/** Told to the user when they refused an ask themselves. */
const DENIED_REASON = 'Denied from the browser.';

/** Told to the user when the ask sat unanswered until its deadline passed. */
const EXPIRED_REASON = 'Nobody answered in time, so it was refused.';

/** What came back about an ask, which is more than just the decision. */
interface PermissionAnswer {
  decision: EnginePermissionDecision;
  /** True when the refusal is a deadline passing rather than a choice. */
  expired: boolean;
}

/**
 * Runs prompts through the engine and reports the answer back.
 *
 * Deltas are forwarded as they arrive so the browser sees text immediately, and
 * the full answer is buffered here so the server can store it as one message.
 * See ADR-008.
 */
export class PromptRunner {
  private readonly options: PromptRunnerOptions;
  private running = false;
  /** True once the browser asked for the running turn to stop. */
  private stopping = false;

  /**
   * Asks this turn is waiting on, by the id the engine gave them.
   *
   * More than one at a time is possible, because an engine can put up several
   * tool calls in the same step.
   */
  private readonly waiting = new Map<string, (answer: PermissionAnswer) => void>();
  private turnId: string | undefined;
  /**
   * Kills the engine of the turn now running.
   *
   * Held on the instance because the abort has to be reachable from outside the run
   * it belongs to: the stop arrives on the socket while the run is still awaiting the
   * engine. Cleared when the run ends, so a stop can never reach a later turn.
   */
  private abortRun: (() => void) | undefined;

  constructor(options: PromptRunnerOptions) {
    this.options = options;
  }

  /** True while an answer is still streaming. */
  isBusy(): boolean {
    return this.running;
  }

  /**
   * Whether the running turn has been told to stop.
   *
   * Read through a call for the same reason the abandoned flag is: it is set from
   * outside the run, and a direct read inside the run would be narrowed to the value
   * it was given when the run started.
   */
  private isStopping(): boolean {
    return this.stopping;
  }

  /**
   * Applies a decision the server relayed back.
   *
   * An answer naming a different turn is dropped: the only turn that can be
   * waiting is the one running now, so anything else is stale. See ADR-022.
   */
  decide(
    turnId: string,
    permissionId: string,
    decision: EnginePermissionDecision,
    expired = false,
  ): void {
    if (turnId !== this.turnId) {
      return;
    }

    const resolve = this.waiting.get(permissionId);

    if (resolve === undefined) {
      return;
    }

    this.waiting.delete(permissionId);
    resolve({ decision, expired });
  }

  /**
   * Stops the turn the browser asked to stop.
   *
   * The engine process is killed, which is the only thing that reliably ends a turn:
   * an agent waiting on a command that never returns is exactly what this is for, and
   * asking it politely is asking the thing that is stuck.
   *
   * Nothing is reported back. The server ended the turn before it sent this, so
   * anything said about it now would be dropped there anyway, and saying it would
   * only risk describing the user's own tap as a failure. See ADR-042.
   */
  stop(turnId: string): void {
    if (turnId !== this.turnId) {
      return;
    }

    this.stopping = true;

    // An engine holding still for an ask produces no events, so aborting alone could
    // leave the run parked on a promise nobody will resolve. Released as refusals,
    // which is what the engine is told anyway when a turn ends.
    for (const resolve of this.waiting.values()) {
      resolve({ decision: 'reject', expired: false });
    }
    this.waiting.clear();

    this.abortRun?.();
  }

  async run(
    turnId: string,
    text: string,
    engineName: string,
    model: string | undefined,
    resume: string | undefined,
  ): Promise<void> {
    const { engines, cwd, send, onActivity } = this.options;

    // One prompt at a time: the engine runs against a real working directory, so
    // overlapping runs could fight over the same files. This holds across engines
    // too, since they all write to the same workspace.
    if (this.running) {
      send({ type: 'turn_error', turnId, message: 'The agent is still answering.' });
      return;
    }

    const engine = engines.get(engineName);

    // The server only ever names an engine this CLI registered, so this means the
    // two have gone out of step. Reported as a failed turn rather than ignored:
    // the browser is waiting for an answer either way.
    if (engine === undefined) {
      send({
        type: 'turn_error',
        turnId,
        message: `Engine ${engineName} is not available on this machine.`,
      });
      return;
    }

    this.running = true;
    this.turnId = turnId;
    this.stopping = false;
    onActivity();

    let answer = '';
    /**
     * Thinking the model has produced and not yet stored.
     *
     * Kept apart from the answer for the whole turn: they arrive interleaved, and a
     * single buffer would put the deliberation inside the reply. See ADR-037.
     */
    let thought = '';
    let failed = false;

    // Aborting kills the engine process, which ends the loop below. Without this a
    // hung engine would hold the device until the CLI is restarted.
    const controller = new AbortController();
    const timeoutMs = this.options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    let silenceTimer: NodeJS.Timeout | undefined;

    // Reachable from stop(), which arrives on the socket while this run is awaiting
    // the engine.
    this.abortRun = () => {
      controller.abort();
    };

    // Held in an object and read through a function, because the flag is only ever
    // set from the timer callback and a direct read would be narrowed to its
    // initial value.
    const state = { abandoned: false };
    const wasAbandoned = (): boolean => state.abandoned;

    const abandonedMessage = `The engine stopped responding after ${String(Math.round(timeoutMs / 1000))}s and was cancelled.`;

    /**
     * The answer so far, sent along with a failure so the text the user already
     * watched arrive survives a reload. Omitted when nothing was said, because an
     * empty answer is nothing to keep.
     */
    const partial = (): { text?: string } => (answer === '' ? {} : { text: clamp(answer) });

    const stopWaiting = (): void => {
      if (silenceTimer !== undefined) {
        clearTimeout(silenceTimer);
        silenceTimer = undefined;
      }
    };

    /**
     * Restarted by every event, so only silence counts against the turn.
     *
     * Deliberately not unref'd, unlike the idle timer: this is what guarantees a
     * turn ends, so it has to keep the process alive while one is in flight. An
     * unref'd timer would never fire precisely when the engine has gone quiet and
     * nothing else is left to wake the loop.
     */
    const waitForActivity = (): void => {
      stopWaiting();
      silenceTimer = setTimeout(() => {
        state.abandoned = true;
        controller.abort();
      }, timeoutMs);
    };

    /**
     * Puts a tool call in front of the user and waits for the answer.
     *
     * The silence timeout stops for the duration. Waiting for a person produces no
     * engine events at all, so left running it would read a phone in a pocket as a
     * hung engine and abandon a turn that is working exactly as intended. The
     * person has a deadline of their own, enforced by the server. See ADR-022.
     */
    /**
     * Reports a refused tool call, naming the reason this machine actually had.
     *
     * Sent from here rather than from the adapter, because only this level knows
     * whether the user said no, a limit on this machine did, or nobody answered.
     */
    /**
     * Stores the thinking so far, because something else is about to happen.
     *
     * Flushed at the same moments the answer is, so the transcript keeps the order
     * the turn happened in: a thought that led to a tool call is placed before that
     * call rather than after it. Sent before the answer flush for the same reason,
     * since a model thinks before it speaks. See ADR-024 and ADR-037.
     */
    const flushReasoning = (): void => {
      if (thought === '') {
        return;
      }

      send({ type: 'turn_reasoning', turnId, text: clamp(thought) });
      thought = '';
    };

    /** The answer so far, stored because the turn is about to do something else. */
    const flushAnswer = (): void => {
      if (answer === '') {
        return;
      }

      send({ type: 'turn_message', turnId, text: clamp(answer) });
      answer = '';
    };

    const reportRefusal = (tool: string, reason: string): void => {
      flushReasoning();
      flushAnswer();
      send({ type: 'turn_blocked', turnId, tool, reason });
    };

    const requestPermission = async (
      request: EnginePermissionRequest,
    ): Promise<EnginePermissionDecision> => {
      // What this machine already knows, before anyone is troubled. A ceiling
      // refusal never reaches the browser, and a granted rule never asks again.
      // See ADR-022.
      const settled = await this.options.policy?.settle(request);

      if (settled !== undefined) {
        if (settled.decision === 'reject') {
          reportRefusal(request.tool, settled.reason);
        }
        return settled.decision;
      }

      // Empty entries would fail validation on the server and lose the ask
      // entirely, leaving the engine waiting for an answer that never comes.
      const details = request.details.filter((detail) => detail !== '');
      const suggestions = request.suggestions.filter((suggestion) => suggestion !== '');

      const decided = new Promise<PermissionAnswer>((resolve) => {
        this.waiting.set(request.id, resolve);
      });

      stopWaiting();
      onActivity();

      send({
        type: 'turn_permission_request',
        turnId,
        permissionId: request.id,
        tool: request.tool,
        title: request.title,
        ...(request.target !== undefined ? { target: request.target } : {}),
        ...(request.reason !== undefined ? { reason: request.reason } : {}),
        details,
        suggestions,
      });

      const { decision, expired } = await decided;
      onActivity();

      // The turn is already over, which is the only way this resolves without
      // anyone deciding. Reporting now would put a refusal after the turn was
      // reported finished, so the engine is answered and nothing else is said.
      if (this.turnId !== turnId) {
        return decision;
      }

      // Another ask may still be waiting, and restarting the clock while the turn
      // is still blocked on a person would defeat the point of stopping it.
      if (this.waiting.size === 0) {
        waitForActivity();
      }

      if (decision === 'reject') {
        reportRefusal(request.tool, expired ? EXPIRED_REASON : DENIED_REASON);
        return decision;
      }

      if (decision === 'always') {
        // Recorded here rather than left to the engine: the two engines disagree
        // about what a lasting grant means, and one of them would forget it by the
        // next prompt. See ADR-022.
        const granted = (await this.options.policy?.grant(request)) ?? [];

        if (granted.length > 0) {
          send({
            type: 'turn_log',
            turnId,
            text: `Granted on this machine: ${granted.join(', ')}`,
          });
        }
      }

      return decision;
    };

    try {
      const events = engine.prompt(text, {
        cwd,
        signal: controller.signal,
        requestPermission,
        ...(model !== undefined ? { model } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });

      waitForActivity();

      for await (const event of events) {
        // Aborting makes the process report a failure of its own. Reporting that
        // as well would tell the user twice, and the second message would blame
        // the abort rather than the silence that caused it. The timer stays
        // stopped here: the turn is already over. A stop the user asked for is the
        // same situation, and the server has already closed that turn.
        if (wasAbandoned() || this.isStopping()) {
          continue;
        }

        waitForActivity();

        switch (event.type) {
          case 'delta':
            // The model has stopped deliberating and started answering, so the
            // thinking that led here is closed off before the reply opens.
            flushReasoning();
            answer += event.text;
            send({ type: 'delta', turnId, text: clamp(event.text) });
            break;
          case 'reasoning':
            thought += event.text;
            send({ type: 'reasoning_delta', turnId, text: clamp(event.text) });
            break;
          case 'log':
            send({ type: 'turn_log', turnId, text: clamp(event.text) });
            break;
          case 'activity':
            flushReasoning();
            flushAnswer();
            send({
              type: 'turn_activity',
              turnId,
              id: event.id,
              tool: event.tool,
              ...(event.target !== undefined ? { target: event.target } : {}),
            });
            break;
          case 'activity_output':
            send({
              type: 'turn_activity_output',
              turnId,
              activityId: event.id,
              output: clamp(event.output),
            });
            break;
          case 'blocked':
            flushReasoning();
            flushAnswer();
            // The turn keeps running after a refusal, so this is reported rather
            // than treated as a failure. Without it the answer that follows would
            // reference work the user never saw refused.
            send({ type: 'turn_blocked', turnId, tool: event.tool, reason: event.reason });
            break;
          case 'session':
            // Reported even when the turn later fails: the engine conversation
            // exists either way, and losing the id would strand its context.
            send({ type: 'turn_session', turnId, engineSessionId: event.id });
            break;
          case 'error':
            failed = true;
            // Kept for the same reason a partial answer is: the user watched it
            // arrive, and a turn that failed still explains itself through what
            // the model was working on. See ADR-033.
            flushReasoning();
            send({ type: 'turn_error', turnId, message: clamp(event.message), ...partial() });
            break;
          case 'done':
            if (event.exitCode !== 0 && !failed) {
              failed = true;
              flushReasoning();
              send({
                type: 'turn_error',
                turnId,
                message: `Engine exited with code ${String(event.exitCode)}.`,
                ...partial(),
              });
            }
            break;
        }
      }

      // The last stretch of thinking has nothing after it to close it off, so the
      // turn ending is what stores it.
      flushReasoning();

      // A stop the user asked for says nothing at all: the server ended that turn
      // before it told this machine, and it kept what had been said. Reporting now
      // would either be dropped there or describe their own tap as a failure.
      // See ADR-042.
      if (this.isStopping()) {
        // Nothing to report.
      } else if (wasAbandoned()) {
        // An abandoned turn reports why rather than presenting a truncated answer
        // as if the engine had finished.
        send({ type: 'turn_error', turnId, message: abandonedMessage, ...partial() });
      } else if (!failed) {
        send({ type: 'turn_done', turnId, text: clamp(answer) });
      }
    } catch (error) {
      flushReasoning();

      if (!this.isStopping()) {
        send({
          type: 'turn_error',
          turnId,
          message: clamp(
            wasAbandoned()
              ? abandonedMessage
              : error instanceof Error
                ? error.message
                : 'The engine failed.',
          ),
          ...partial(),
        });
      }
    } finally {
      stopWaiting();

      // Nothing will answer these now. Released as refusals rather than left
      // hanging, so an engine still reading its stdin is told where it stands
      // instead of waiting on a turn that is already over.
      for (const resolve of this.waiting.values()) {
        resolve({ decision: 'reject', expired: false });
      }
      this.waiting.clear();

      this.abortRun = undefined;
      this.turnId = undefined;
      this.running = false;
      this.stopping = false;
      onActivity();
    }
  }
}
