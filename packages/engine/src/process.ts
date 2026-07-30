import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineEvent } from './types.js';
import { resolveCommand } from './which.js';

export interface SpawnOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * Written to the child's stdin and then closed. Prompts travel this way so no
   * shell quoting or command line length limit can corrupt them.
   */
  input?: string;
  signal?: AbortSignal;
}

/**
 * Maps a line of engine output to events, or undefined to drop the line.
 *
 * An array is allowed because one line can describe several things at once: a
 * single assistant message may contain more than one tool call.
 */
export type LineMapper = (line: string) => EngineEvent | EngineEvent[] | undefined;

/**
 * Spawns an engine process and streams its output line by line.
 *
 * stdout goes through the adapter's mapper because every engine formats its
 * answer differently. stderr is always emitted as a log so diagnostics never
 * leak into assistant text.
 */
export async function* streamProcess(
  options: SpawnOptions,
  mapStdout: LineMapper,
): AsyncGenerator<EngineEvent> {
  const resolved = await resolveCommand(options.command);

  if (resolved === undefined) {
    yield { type: 'error', message: `Cannot find ${options.command} on PATH.` };
    yield { type: 'done', exitCode: 127 };
    return;
  }

  // Node refuses to execute Windows batch shims directly, and npm installs most
  // CLIs as a .cmd shim. Those have to be launched through cmd.exe. shell is
  // never enabled, so arguments are still passed as a list and no quoting or
  // injection can happen.
  const command = resolved.isBatch ? 'cmd.exe' : resolved.path;
  const args = resolved.isBatch
    ? ['/d', '/s', '/c', resolved.path, ...options.args]
    : [...options.args];

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  if (options.input !== undefined && child.stdin !== null) {
    child.stdin.on('error', () => {
      // The engine may exit before reading stdin. Losing that write is not a
      // failure on its own, the exit code already reports what happened.
    });
    child.stdin.end(options.input);
  }

  // null marks the end of the stream. A sentinel avoids a separate "finished"
  // flag, which the compiler cannot narrow correctly when callbacks set it.
  const queue: (EngineEvent | null)[] = [];
  let notify: (() => void) | undefined;

  const push = (event: EngineEvent | null): void => {
    queue.push(event);
    const resume = notify;
    notify = undefined;
    resume?.();
  };

  if (child.stdout === null || child.stderr === null) {
    yield { type: 'error', message: 'Engine process has no output streams.' };
    yield { type: 'done', exitCode: 1 };
    return;
  }

  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });

  stdout.on('line', (line) => {
    const mapped = mapStdout(line);

    if (mapped === undefined) {
      return;
    }

    for (const event of Array.isArray(mapped) ? mapped : [mapped]) {
      push(event);
    }
  });

  stderr.on('line', (line) => {
    if (line.trim() !== '') {
      push({ type: 'log', text: line });
    }
  });

  child.on('error', (error) => {
    push({ type: 'error', message: error.message });
    push(null);
  });

  // close fires after the stdio streams have ended, so every line has already
  // been queued by the time the stream is marked done.
  child.on('close', (code) => {
    push({ type: 'done', exitCode: code ?? 0 });
    push(null);
  });

  /**
   * Takes the next queued item, waiting when the queue is empty. Returns null
   * once the process has ended and everything queued has been drained.
   */
  const next = async (): Promise<EngineEvent | null> => {
    for (;;) {
      const event = queue.shift();
      if (event !== undefined) {
        return event;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  };

  try {
    for (let event = await next(); event !== null; event = await next()) {
      yield event;
    }
  } finally {
    stdout.close();
    stderr.close();
  }
}
