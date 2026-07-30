import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptRunner } from '../dist/pairing/prompt-runner.js';
import type { Engine, EngineEvent, PromptOptions } from '@remotecode/engine';
import type { CliMessage } from '@remotecode/protocol';

const wait = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * An engine that yields what it was given, then stays silent until aborted.
 *
 * Silence is the case that matters: a real engine that hangs never ends its
 * stream, so the runner has to be the one to give up.
 */
class ScriptedEngine implements Engine {
  readonly name = 'scripted';
  readonly command = 'scripted';
  aborted = false;
  private readonly events: EngineEvent[];
  private readonly thenHang: boolean;

  constructor(events: EngineEvent[], thenHang: boolean) {
    this.events = events;
    this.thenHang = thenHang;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<string[]> {
    return ['scripted/fast'];
  }

  async *prompt(_text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    for (const event of this.events) {
      yield event;
    }

    if (!this.thenHang) {
      return;
    }

    // Waits for the abort rather than ending, which is what a hung engine does.
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener('abort', () => {
        this.aborted = true;
        resolve();
      });
    });
  }
}

function collect(): { sent: CliMessage[]; send: (message: CliMessage) => void } {
  const sent: CliMessage[] = [];
  return { sent, send: (message) => sent.push(message) };
}

function typesOf(sent: CliMessage[]): string[] {
  return sent.map((message) => message.type);
}

test('a silent engine is cancelled instead of holding the device', async () => {
  const engine = new ScriptedEngine([{ type: 'delta', text: 'starting' }], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  // The engine process has to actually be told to stop, not just ignored.
  assert.equal(engine.aborted, true);
  assert.equal(runner.isBusy(), false);

  const error = sent.find((message) => message.type === 'turn_error');
  assert.match(error?.type === 'turn_error' ? error.message : '', /stopped responding/);
});

test('a cancelled turn reports the text it already produced', async () => {
  const engine = new ScriptedEngine([{ type: 'delta', text: 'got this far' }], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  // The server can only keep what the CLI reports, so the partial answer has to
  // travel with the failure rather than being dropped here.
  const error = sent.find((message) => message.type === 'turn_error');
  assert.equal(error?.type === 'turn_error' ? error.text : undefined, 'got this far');
});

test('a failure with nothing produced carries no text', async () => {
  const engine = new ScriptedEngine([{ type: 'error', message: 'not logged in' }], false);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  // An empty answer is nothing to keep, so the field is left off entirely.
  const error = sent.find((message) => message.type === 'turn_error');
  assert.equal(error?.type === 'turn_error' ? error.text : 'unset', undefined);
});

test('a cancelled turn is reported once, not twice', async () => {
  const engine = new ScriptedEngine([{ type: 'delta', text: 'hello' }], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 60,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  // Aborting makes the engine report a failure of its own, which would otherwise
  // reach the user as a second, more confusing message.
  assert.equal(typesOf(sent).filter((type) => type === 'turn_error').length, 1);
  // A cancelled turn never claims to have finished.
  assert.equal(typesOf(sent).includes('turn_done'), false);
});

/**
 * Streams for far longer than the timeout while never falling silent for it.
 *
 * This is the case a total-duration limit would get wrong: a long task that keeps
 * reporting progress is working as intended.
 */
class SlowButTalkingEngine implements Engine {
  readonly name = 'slow';
  readonly command = 'slow';
  aborted = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async listModels(): Promise<string[]> {
    return [];
  }

  async *prompt(_text: string, options: PromptOptions): AsyncGenerator<EngineEvent> {
    options.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });

    for (let index = 0; index < 6; index += 1) {
      await wait(30);
      yield { type: 'delta', text: 'x' };
    }

    yield { type: 'done', exitCode: 0 };
  }
}

test('an engine that keeps talking is never cancelled', async () => {
  const engine = new SlowButTalkingEngine();
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  // Total runtime is about 180ms against an 80ms limit, so measuring the whole
  // turn instead of the gaps would have killed a healthy answer.
  assert.equal(engine.aborted, false);
  assert.equal(typesOf(sent).includes('turn_error'), false);

  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'xxxxxx');
});

test('a finished turn frees the runner for the next prompt', async () => {
  const engine = new ScriptedEngine(
    [
      { type: 'delta', text: 'done' },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  assert.equal(runner.isBusy(), false);

  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'done');
});

test('a second prompt while busy is refused', async () => {
  const engine = new ScriptedEngine([], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 120,
  });

  const first = runner.run('turn-1', 'hi', undefined, undefined);
  await wait(20);

  // One prompt at a time: the engine works against real files, so overlapping
  // runs could fight over the same directory.
  await runner.run('turn-2', 'again', undefined, undefined);

  const refusal = sent.find(
    (message) => message.type === 'turn_error' && message.turnId === 'turn-2',
  );
  assert.notEqual(refusal, undefined);

  await first;
});

test('a refused tool call is forwarded without ending the turn', async () => {
  const engine = new ScriptedEngine(
    [
      { type: 'blocked', tool: 'Write', reason: 'not granted yet' },
      { type: 'delta', text: 'could not do it' },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engine,
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', undefined, undefined);

  const blocked = sent.find((message) => message.type === 'turn_blocked');
  assert.equal(blocked?.type === 'turn_blocked' ? blocked.tool : '', 'Write');

  // The engine answers around a refusal, so the turn still finishes normally.
  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'could not do it');
  assert.equal(typesOf(sent).includes('turn_error'), false);
});
