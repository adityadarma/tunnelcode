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
  /** Unique ID for the tool call as provided by the engine. */
  id: string;
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
 * Output from a tool call, if the engine reports it.
 */
export interface EngineActivityOutput {
  type: 'activity_output';
  /** The unique ID of the tool call this output belongs to. */
  id: string;
  /** The output string. */
  output: string;
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

/**
 * A tool call the engine was not allowed to make.
 *
 * Reported separately from an error because the turn carries on: the engine is
 * told it was refused and answers around it. Without this the refusal is invisible
 * and the answer that follows has no visible cause.
 */
export interface EngineBlocked {
  type: 'blocked';
  /** Tool that was refused, named as the engine reported it. */
  tool: string;
  /** Why it was refused, as the engine explained it. */
  reason: string;
}

/**
 * A tool call the engine will not run until someone allows it.
 *
 * Distinct from EngineBlocked, which reports a call that was already refused.
 * This one is still waiting, and the turn does not continue until it is answered.
 * See ADR-022.
 */
export interface EnginePermissionRequest {
  /** Identifies the ask within its run, so an answer can be matched to it. */
  id: string;
  /** Tool as the engine named it. */
  tool: string;
  /** Label written for a person, rather than the raw tool name. */
  title: string;
  /**
   * What the call would act on. Absent when the engine did not say, for the same
   * reason EngineActivity leaves it out.
   */
  target?: string;
  /** Why the engine is asking, when it explains itself. */
  reason?: string;
  /**
   * The concrete operations this one ask covers.
   *
   * A list rather than a string because the engines do not agree on granularity:
   * one asks per tool call, the other can cover several commands with a single
   * ask. Showing only the first would hide what is being agreed to.
   */
  details: string[];
  /**
   * Rules that would allow calls like this one without asking again, worded by
   * the engine that raised the ask.
   *
   * Reported rather than applied, because a lasting grant belongs to this machine
   * and not to the engine's own configuration. See ADR-022.
   */
  suggestions: string[];
}

/**
 * What to do about an ask.
 *
 * Named after OpenCode's vocabulary because it is the one that distinguishes all
 * three cases; Claude has no lasting grant of its own, so 'always' is allowed on
 * the wire and remembered here instead.
 */
export type EnginePermissionDecision = 'once' | 'always' | 'reject';

export interface EngineDone {
  type: 'done';
  exitCode: number;
}

export interface EngineFailure {
  type: 'error';
  message: string;
}

export type EngineEvent =
  | EngineDelta
  | EngineLog
  | EngineActivity
  | EngineActivityOutput
  | EngineSession
  | EngineBlocked
  | EngineDone
  | EngineFailure;

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
  /**
   * Asked when the engine will not run a tool call on its own.
   *
   * Absent leaves the engine to decide alone, which for both supported engines
   * means refusing, so the answer explains what it could not do. Providing this
   * is what turns asks on. See ADR-022.
   */
  requestPermission?: (request: EnginePermissionRequest) => Promise<EnginePermissionDecision>;
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
  /**
   * Releases whatever the adapter is holding open.
   *
   * Optional because most engines hold nothing between turns. One that runs a
   * server of its own does, and leaving it up would keep an agent with access to
   * the workspace alive after the session that needed it ended.
   */
  stop?(): void;
}
