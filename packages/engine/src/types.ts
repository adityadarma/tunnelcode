/**
 * Text produced by the engine, forwarded to the browser as it arrives.
 */
export interface EngineDelta {
  type: 'delta';
  text: string;
}

/**
 * Diagnostic output from the engine. Kept separate from deltas so stderr noise
 * never ends up inside an assistant message.
 */
export interface EngineLog {
  type: 'log';
  text: string;
}

/**
 * Something the engine did rather than said: a file it touched, a command it
 * ran, a search it performed.
 *
 * Kept separate from deltas because this is not part of the answer text. The
 * engine reports these as tool calls, and every engine names its tools
 * differently, so the adapter maps them onto this shape.
 */
export interface EngineActivity {
  type: 'activity';
  /** Tool name as the engine reported it, for example 'write' or 'bash'. */
  tool: string;
  /**
   * What the tool acted on: a file path, a command line, a search pattern.
   * Absent when the engine did not say, which is why it is optional rather than
   * an empty string.
   */
  target?: string;
}

/**
 * The engine's own conversation id for this run.
 *
 * Reported so the next prompt can be resumed into the same engine conversation,
 * which is what gives the agent memory of what was already said. Engines that
 * cannot report one simply never emit this, and every prompt then starts fresh.
 */
export interface EngineSession {
  type: 'session';
  id: string;
}

export interface EngineDone {
  type: 'done';
  exitCode: number;
}

export interface EngineFailure {
  type: 'error';
  message: string;
}

export type EngineEvent =
  EngineDelta | EngineLog | EngineActivity | EngineSession | EngineDone | EngineFailure;

export interface PromptOptions {
  /** Working directory the engine runs in. */
  cwd: string;
  /** Model to answer with, taken from listModels. */
  model?: string;
  /**
   * Engine conversation to continue, as reported by an earlier run.
   *
   * Absent starts a new engine conversation. A stale id is not an error the
   * caller has to handle: the adapter falls back to starting fresh, because
   * refusing to answer would be worse than answering without the earlier
   * context.
   */
  resume?: string;
  /** Aborts the engine process when the caller no longer needs the answer. */
  signal?: AbortSignal;
}

/**
 * Engine adapter contract. Concrete engines translate their own CLI output into
 * EngineEvent, so business logic never depends on a specific engine. See
 * ADR-010.
 */
export interface Engine {
  /** Engine name as written in configuration. */
  readonly name: string;
  /** Executable this engine spawns. */
  readonly command: string;
  /** Whether the executable can be found on PATH. */
  isAvailable(): Promise<boolean>;
  /**
   * Models this engine can answer with. Empty when the engine cannot report
   * them, which the UI treats as "use the engine default".
   */
  listModels(): Promise<string[]>;
  /** Sends a prompt and streams the answer. */
  prompt(text: string, options: PromptOptions): AsyncGenerator<EngineEvent>;
}
