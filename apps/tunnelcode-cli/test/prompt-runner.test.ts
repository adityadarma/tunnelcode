import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptRunner } from '../dist/pairing/prompt-runner.js';
import type { Engine, EngineEvent, PromptOptions } from '@tunnelcode/engine';
import { ENGINE_TEXT_MAX_LENGTH, parseCliMessage } from '@tunnelcode/protocol';
import type { CliMessage } from '@tunnelcode/protocol';

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
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

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
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  // The server can only keep what the CLI reports, so the partial answer has to
  // travel with the failure rather than being dropped here.
  const error = sent.find((message) => message.type === 'turn_error');
  assert.equal(error?.type === 'turn_error' ? error.text : undefined, 'got this far');
});

test('a failure with nothing produced carries no text', async () => {
  const engine = new ScriptedEngine([{ type: 'error', message: 'not logged in' }], false);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  // An empty answer is nothing to keep, so the field is left off entirely.
  const error = sent.find((message) => message.type === 'turn_error');
  assert.equal(error?.type === 'turn_error' ? error.text : 'unset', undefined);
});

test('a cancelled turn is reported once, not twice', async () => {
  const engine = new ScriptedEngine([{ type: 'delta', text: 'hello' }], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 60,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

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
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 80,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

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
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  assert.equal(runner.isBusy(), false);

  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'done');
});

test('a second prompt while busy is refused', async () => {
  const engine = new ScriptedEngine([], true);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 120,
  });

  const first = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(20);

  // One prompt at a time: the engine works against real files, so overlapping
  // runs could fight over the same directory.
  await runner.run('turn-2', 'again', engine.name, undefined, undefined);

  const refusal = sent.find(
    (message) => message.type === 'turn_error' && message.turnId === 'turn-2',
  );
  assert.notEqual(refusal, undefined);

  await first;
});

test('a prompt naming an engine this machine lacks fails the turn', async () => {
  const engine = new ScriptedEngine([{ type: 'delta', text: 'hello' }], false);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', 'gemini', undefined, undefined);

  // The browser is waiting for an answer either way, so this is reported rather
  // than ignored. The installed engine must not answer in its place.
  const error = sent.find((message) => message.type === 'turn_error');
  assert.match(error?.type === 'turn_error' ? error.message : '', /not available/);
  assert.equal(typesOf(sent).includes('delta'), false);
  assert.equal(runner.isBusy(), false);
});

test('each turn runs on the engine it names', async () => {
  const fast = new ScriptedEngine(
    [
      { type: 'delta', text: 'from fast' },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const slow = new SlowButTalkingEngine();
  const { sent, send } = collect();

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([
      ['scripted', fast],
      ['slow', slow],
    ]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', 'scripted', undefined, undefined);

  // One machine now serves several engines, so the name on the turn is what
  // decides which one answers. See ADR-020.
  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'from fast');
  assert.equal(slow.aborted, false);
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
    // Keyed by name, because a prompt names the engine it needs now.
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  const blocked = sent.find((message) => message.type === 'turn_blocked');
  assert.equal(blocked?.type === 'turn_blocked' ? blocked.tool : '', 'Write');

  // The engine answers around a refusal, so the turn still finishes normally.
  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'could not do it');
  assert.equal(typesOf(sent).includes('turn_error'), false);
});

/**
 * Asks for permission, then waits far longer than the silence timeout before
 * saying anything else.
 *
 * This is the case the timeout gets wrong on its own: waiting for a person
 * produces no engine events at all, so a phone in a pocket looks exactly like a
 * hung engine. See ADR-022.
 */
class AskingEngine implements Engine {
  readonly name = 'asking';
  readonly command = 'asking';
  aborted = false;
  decision: string | undefined;
  private readonly waitMs: number;

  constructor(waitMs: number) {
    this.waitMs = waitMs;
  }

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

    yield { type: 'activity', id: 'call-1', tool: 'Bash', target: 'curl example.com' };

    this.decision = await options.requestPermission?.({
      id: 'per-1',
      tool: 'Bash',
      title: 'Bash',
      target: 'curl example.com',
      reason: 'This command requires approval',
      details: ['Fetch example.com', ''],
      suggestions: [],
    });

    await wait(this.waitMs);

    yield { type: 'delta', text: `decided ${String(this.decision)}` };
    yield { type: 'done', exitCode: 0 };
  }
}

test('an ask is reported with what the engine said about it', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  await wait(30);
  const request = sent.find((message) => message.type === 'turn_permission_request');
  assert.ok(request !== undefined && request.type === 'turn_permission_request');
  assert.equal(request.permissionId, 'per-1');
  assert.equal(request.tool, 'Bash');
  assert.equal(request.reason, 'This command requires approval');
  // An empty entry would fail validation on the server and lose the whole ask,
  // leaving the engine waiting for an answer that never comes.
  assert.deepEqual(request.details, ['Fetch example.com']);

  runner.decide('turn-1', 'per-1', 'once');
  await running;

  assert.equal(engine.decision, 'once');
});

test('waiting for a person does not count as engine silence', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 60,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  // Three times the timeout with the engine saying nothing at all, because it is
  // blocked on the answer rather than hung.
  await wait(200);
  assert.equal(engine.aborted, false, 'the turn survives the wait');

  runner.decide('turn-1', 'per-1', 'always');
  await running;

  assert.equal(engine.decision, 'always');
  assert.equal(typesOf(sent).includes('turn_error'), false);

  const done = sent.find((message) => message.type === 'turn_done');
  assert.equal(done?.type === 'turn_done' ? done.text : '', 'decided always');
});

test('the clock restarts once the answer arrives', async () => {
  // Silent for longer than the timeout after the decision, which is the engine
  // genuinely hanging rather than waiting on anybody.
  const engine = new AskingEngine(400);
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 60,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);
  runner.decide('turn-1', 'per-1', 'once');

  await running;

  // Stopping the clock for the ask must not leave it stopped for the rest of the
  // turn, or a hung engine after an approval would hold the device forever.
  assert.equal(engine.aborted, true);
  const error = sent.find((message) => message.type === 'turn_error');
  assert.match(error?.type === 'turn_error' ? error.message : '', /stopped responding/);
});

test('an answer for another turn is ignored', async () => {
  const engine = new AskingEngine(0);
  const { send } = collect();
  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);

  // Stale, from a turn that is already over. Applying it would decide the ask the
  // current turn is waiting on.
  runner.decide('turn-0', 'per-1', 'reject');
  assert.equal(engine.decision, undefined);

  runner.decide('turn-1', 'per-1', 'once');
  await running;

  assert.equal(engine.decision, 'once');
});

test('a turn that ends releases an unanswered ask as a refusal', async () => {
  const engine = new AskingEngine(0);
  const { send } = collect();
  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);
  runner.decide('turn-1', 'per-1', 'once');
  await running;

  // The runner has to be usable again afterwards, with nothing left waiting from
  // the turn before.
  assert.equal(runner.isBusy(), false);

  const second = new AskingEngine(0);
  const later = collect();
  const next = new PromptRunner({
    engines: new Map<string, Engine>([[second.name, second]]),
    cwd: process.cwd(),
    send: later.send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const secondRun = next.run('turn-2', 'hi', second.name, undefined, undefined);
  await wait(30);
  next.decide('turn-2', 'per-1', 'reject');
  await secondRun;

  assert.equal(second.decision, 'reject');
});

/** A policy the test drives directly, standing in for this machine's files. */
function policyOf(
  settled: { decision: 'once' | 'always' | 'reject'; reason: string } | undefined,
): {
  policy: {
    settle: () => Promise<{ decision: 'once' | 'always' | 'reject'; reason: string } | undefined>;
    grant: () => Promise<string[]>;
  };
  granted: number[];
} {
  const granted: number[] = [];

  return {
    policy: {
      settle: async () => settled,
      grant: async () => {
        granted.push(1);
        return ['Bash(curl *)'];
      },
    },
    granted,
  };
}

test('a ceiling refusal never reaches the browser', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();
  const { policy } = policyOf({
    decision: 'reject',
    reason: 'Not allowed on this machine: bash(curl *).',
  });

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    policy,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  // Asking about something this machine will never allow would offer a choice the
  // user does not really have. See ADR-022.
  assert.equal(typesOf(sent).includes('turn_permission_request'), false);
  assert.equal(engine.decision, 'reject');

  // The reason is the machine's, not "you denied it", which would be false.
  const blocked = sent.find((message) => message.type === 'turn_blocked');
  assert.match(
    blocked?.type === 'turn_blocked' ? blocked.reason : '',
    /Not allowed on this machine/,
  );
});

test('a granted rule answers without asking anyone', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();
  const { policy } = policyOf({
    decision: 'once',
    reason: 'Allowed by a rule granted on this machine.',
  });

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    policy,
    silenceTimeoutMs: 500,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  // The point of "always": the phone is not troubled again for the same thing.
  assert.equal(typesOf(sent).includes('turn_permission_request'), false);
  assert.equal(typesOf(sent).includes('turn_blocked'), false);
  assert.equal(engine.decision, 'once');
});

test('always records the grant on this machine', async () => {
  const engine = new AskingEngine(0);
  const { send } = collect();
  const { policy, granted } = policyOf(undefined);

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    policy,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);
  runner.decide('turn-1', 'per-1', 'always');
  await running;

  // Neither engine keeps a grant that would survive this run in a way TunnelCode
  // could rely on, so recording it here is what makes 'always' mean anything.
  assert.equal(granted.length, 1);
  assert.equal(engine.decision, 'always');
});

test('a refusal the user chose says so', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);
  runner.decide('turn-1', 'per-1', 'reject');
  await running;

  const blocked = sent.find((message) => message.type === 'turn_blocked');
  assert.equal(blocked?.type === 'turn_blocked' ? blocked.reason : '', 'Denied from the browser.');
});

test('a refusal nobody chose is not blamed on the user', async () => {
  const engine = new AskingEngine(0);
  const { sent, send } = collect();

  const runner = new PromptRunner({
    engines: new Map<string, Engine>([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
    silenceTimeoutMs: 500,
  });

  const running = runner.run('turn-1', 'hi', engine.name, undefined, undefined);
  await wait(30);
  // What the server sends when the deadline passed with the phone in a pocket.
  runner.decide('turn-1', 'per-1', 'reject', true);
  await running;

  const blocked = sent.find((message) => message.type === 'turn_blocked');
  assert.match(blocked?.type === 'turn_blocked' ? blocked.reason : '', /Nobody answered in time/);
});

test('output too long to send is shortened rather than dropped', async () => {
  const huge = 'x'.repeat(ENGINE_TEXT_MAX_LENGTH + 5000);
  const engine = new ScriptedEngine(
    [
      { type: 'activity', id: 'call-1', tool: 'bash' },
      { type: 'activity_output', id: 'call-1', output: huge },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  const output = sent.find((message) => message.type === 'turn_activity_output');
  const text = output?.type === 'turn_activity_output' ? output.output : '';

  // The protocol refuses a field this long, and a refused frame is a turn the
  // browser never sees finish. Shortened here so the turn still completes.
  assert.ok(text.length <= ENGINE_TEXT_MAX_LENGTH);
  assert.match(text, /5000 more characters were not sent/);
  // Every frame still parses, which is the point of doing this in the CLI.
  assert.ok(sent.every((message) => parseCliMessage(JSON.stringify(message)) !== undefined));
});

test('an answer too long to send is shortened and the turn still finishes', async () => {
  const engine = new ScriptedEngine(
    [
      { type: 'delta', text: 'y'.repeat(ENGINE_TEXT_MAX_LENGTH) },
      { type: 'delta', text: 'y'.repeat(1000) },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  const done = sent.find((message) => message.type === 'turn_done');
  assert.notEqual(done, undefined);

  const text = done?.type === 'turn_done' ? done.text : '';
  assert.ok(text.length <= ENGINE_TEXT_MAX_LENGTH);
  assert.match(text, /1000 more characters were not sent/);
  assert.ok(sent.every((message) => parseCliMessage(JSON.stringify(message)) !== undefined));
});

test('output that fits is left exactly as it was', async () => {
  const exact = 'z'.repeat(ENGINE_TEXT_MAX_LENGTH);
  const engine = new ScriptedEngine(
    [
      { type: 'activity', id: 'call-1', tool: 'bash' },
      { type: 'activity_output', id: 'call-1', output: exact },
      { type: 'done', exitCode: 0 },
    ],
    false,
  );
  const { sent, send } = collect();
  const runner = new PromptRunner({
    engines: new Map([[engine.name, engine]]),
    cwd: process.cwd(),
    send,
    onActivity: () => undefined,
  });

  await runner.run('turn-1', 'hi', engine.name, undefined, undefined);

  const output = sent.find((message) => message.type === 'turn_activity_output');

  // Nothing is added to output that was already acceptable, so the limit never
  // shows up in ordinary work.
  assert.equal(output?.type === 'turn_activity_output' ? output.output : '', exact);
});
