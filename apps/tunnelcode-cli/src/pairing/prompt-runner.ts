import type { Engine } from '@tunnelcode/engine';
import type { CliMessage } from '@tunnelcode/protocol';

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
  engine: Engine;
  cwd: string;
  send: (message: CliMessage) => void;
  /** Called on conversation activity, which is what resets the idle timeout. */
  onActivity: () => void;
  /** Overridden in tests, which cannot wait minutes for a real timeout. */
  silenceTimeoutMs?: number;
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

  constructor(options: PromptRunnerOptions) {
    this.options = options;
  }

  /** True while an answer is still streaming. */
  isBusy(): boolean {
    return this.running;
  }

  async run(
    turnId: string,
    text: string,
    model: string | undefined,
    resume: string | undefined,
  ): Promise<void> {
    const { engine, cwd, send, onActivity } = this.options;

    // One prompt at a time: the engine runs against a real working directory, so
    // overlapping runs could fight over the same files.
    if (this.running) {
      send({ type: 'turn_error', turnId, message: 'The agent is still answering.' });
      return;
    }

    this.running = true;
    onActivity();

    let answer = '';
    let failed = false;

    // Aborting kills the engine process, which ends the loop below. Without this a
    // hung engine would hold the device until the CLI is restarted.
    const controller = new AbortController();
    const timeoutMs = this.options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
    let silenceTimer: NodeJS.Timeout | undefined;

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
    const partial = (): { text?: string } => (answer === '' ? {} : { text: answer });

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

    try {
      const events = engine.prompt(text, {
        cwd,
        signal: controller.signal,
        ...(model !== undefined ? { model } : {}),
        ...(resume !== undefined ? { resume } : {}),
      });

      waitForActivity();

      for await (const event of events) {
        // Aborting makes the process report a failure of its own. Reporting that
        // as well would tell the user twice, and the second message would blame
        // the abort rather than the silence that caused it. The timer stays
        // stopped here: the turn is already over.
        if (wasAbandoned()) {
          continue;
        }

        waitForActivity();

        switch (event.type) {
          case 'delta':
            answer += event.text;
            send({ type: 'delta', turnId, text: event.text });
            break;
          case 'log':
            send({ type: 'turn_log', turnId, text: event.text });
            break;
          case 'activity':
            send({
              type: 'turn_activity',
              turnId,
              tool: event.tool,
              ...(event.target !== undefined ? { target: event.target } : {}),
            });
            break;
          case 'blocked':
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
            send({ type: 'turn_error', turnId, message: event.message, ...partial() });
            break;
          case 'done':
            if (event.exitCode !== 0 && !failed) {
              failed = true;
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

      // An abandoned turn reports why rather than presenting a truncated answer as
      // if the engine had finished.
      if (wasAbandoned()) {
        send({ type: 'turn_error', turnId, message: abandonedMessage, ...partial() });
      } else if (!failed) {
        send({ type: 'turn_done', turnId, text: answer });
      }
    } catch (error) {
      send({
        type: 'turn_error',
        turnId,
        message: wasAbandoned()
          ? abandonedMessage
          : error instanceof Error
            ? error.message
            : 'The engine failed.',
        ...partial(),
      });
    } finally {
      stopWaiting();
      this.running = false;
      onActivity();
    }
  }
}
