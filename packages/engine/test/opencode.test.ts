import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { OpenCodeEngine } from '../dist/adapters/opencode.js';
import type { EngineEvent, EnginePermissionRequest, PromptOptions } from '../dist/types.js';
import { withEmptyPath, withFakeEngine } from './helpers.ts';

const SESSION = 'ses-1';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface FakeOpenCode {
  /** Every request the adapter made, in order. */
  requests: Recorded[];
  /** Permission ids answered, with the answer. */
  replies: { permissionId: string; response: unknown }[];
}

interface FakeOptions {
  /** Sent down the event stream once a prompt has been accepted. */
  events: unknown[];
  /** Session ids the server refuses to continue, standing in for a pruned one. */
  unknown?: string[];
  /** Session id handed out for a newly created session. */
  sessionId?: string;
}

/**
 * Runs the adapter against a stand-in for the opencode server.
 *
 * The real engine is a paid API behind a process that takes seconds to start, so
 * the adapter is verified against the shapes recorded from it instead.
 */
async function withFakeOpenCode<T>(
  options: FakeOptions,
  run: (engine: OpenCodeEngine, fake: FakeOpenCode) => Promise<T>,
): Promise<T> {
  const fake: FakeOpenCode = { requests: [], replies: [] };
  const streams = new Set<ServerResponse>();
  const created = options.sessionId ?? SESSION;

  const send = (): void => {
    for (const stream of streams) {
      for (const event of options.events) {
        stream.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  };

  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }

      fake.requests.push({ method: request.method ?? '', path, body });

      if (path.startsWith('/event')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // Without this the headers sit in a buffer and the adapter's fetch never
        // resolves, so the prompt that triggers the events is never sent.
        response.flushHeaders();
        streams.add(response);
        response.on('close', () => {
          streams.delete(response);
        });
        return;
      }

      const permission = /^\/session\/([^/]+)\/permissions\/([^/?]+)/.exec(path);

      if (permission?.[2] !== undefined) {
        fake.replies.push({
          permissionId: decodeURIComponent(permission[2]),
          response: (body as { response?: unknown } | undefined)?.response,
        });
        response.writeHead(200).end('true');
        return;
      }

      const prompt = /^\/session\/([^/]+)\/prompt_async/.exec(path);

      if (prompt?.[1] !== undefined) {
        const id = decodeURIComponent(prompt[1]);

        if (options.unknown?.includes(id) === true) {
          response.writeHead(404).end('{}');
          return;
        }

        response.writeHead(200).end('{}');
        // Sent after the prompt is accepted, which is the order the adapter has to
        // survive: it subscribes first so nothing can slip through the gap.
        setTimeout(send, 5);
        return;
      }

      if (path === '/session') {
        response.writeHead(200).end(JSON.stringify({ id: created }));
        return;
      }

      response.writeHead(200).end('{}');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const engine = new OpenCodeEngine({
    startServer: async () => ({
      baseUrl: `http://127.0.0.1:${String(port)}`,
      authorization: 'Basic test',
      stop: () => undefined,
    }),
  });

  try {
    return await run(engine, fake);
  } finally {
    for (const stream of streams) {
      stream.end();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

const userMessage = {
  type: 'message.updated',
  properties: { sessionID: SESSION, info: { id: 'msg-user', role: 'user' } },
};
const assistantMessage = {
  type: 'message.updated',
  properties: { sessionID: SESSION, info: { id: 'msg-1', role: 'assistant' } },
};

function textPart(id: string, text: string, messageID = 'msg-1'): unknown {
  return {
    type: 'message.part.updated',
    properties: { sessionID: SESSION, part: { type: 'text', id, text, messageID } },
  };
}

function delta(partID: string, text: string): unknown {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: SESSION,
      messageID: 'msg-1',
      partID,
      field: 'text',
      delta: text,
    },
  };
}

function toolPart(state: Record<string, unknown>): unknown {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: SESSION,
      part: { type: 'tool', tool: 'bash', callID: 'call-1', messageID: 'msg-1', state },
    },
  };
}

function idleFor(sessionID: string): unknown {
  return { type: 'session.idle', properties: { sessionID } };
}

const idle = idleFor(SESSION);

async function collect(events: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];

  for await (const event of events) {
    out.push(event);
  }

  return out;
}

function textOf(events: EngineEvent[]): string {
  return events
    .filter((event): event is Extract<EngineEvent, { type: 'delta' }> => event.type === 'delta')
    .map((event) => event.text)
    .join('');
}

type Activity = Extract<EngineEvent, { type: 'activity' }>;
type Blocked = Extract<EngineEvent, { type: 'blocked' }>;

function activitiesOf(events: EngineEvent[]): Activity[] {
  return events.filter((event): event is Activity => event.type === 'activity');
}

function blockedOf(events: EngineEvent[]): Blocked[] {
  return events.filter((event): event is Blocked => event.type === 'blocked');
}

const base: PromptOptions = { cwd: process.cwd() };

test('streamed fragments are forwarded in order', async () => {
  await withFakeOpenCode(
    {
      events: [
        assistantMessage,
        delta('prt-1', 'Hel'),
        delta('prt-1', 'lo '),
        delta('prt-1', 'world'),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      assert.equal(textOf(events), 'Hello world');
    },
  );
});

test('the prompt is never replayed as the answer', async () => {
  await withFakeOpenCode(
    {
      // The user's own words come back as a part of their own, which reads exactly
      // like assistant text on the wire.
      events: [
        userMessage,
        textPart('prt-user', 'what did I ask', 'msg-user'),
        assistantMessage,
        delta('prt-1', 'the answer'),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('what did I ask', base));
      assert.equal(textOf(events), 'the answer');
    },
  );
});

test('a part that never streamed is still emitted, once', async () => {
  await withFakeOpenCode(
    {
      // What a provider answering in one piece produces: no fragments, and the part
      // repeated as it is finished.
      events: [
        assistantMessage,
        textPart('prt-1', 'all at once'),
        textPart('prt-1', 'all at once'),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      assert.equal(textOf(events), 'all at once');
    },
  );
});

test('a streamed part is not repeated when it is finished', async () => {
  await withFakeOpenCode(
    {
      events: [assistantMessage, delta('prt-1', 'streamed'), textPart('prt-1', 'streamed'), idle],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      assert.equal(textOf(events), 'streamed');
    },
  );
});

test('a tool call is reported once, with what it acts on', async () => {
  await withFakeOpenCode(
    {
      events: [
        assistantMessage,
        // Announced before its arguments exist, which is why the first sighting is
        // not what gets reported.
        toolPart({ status: 'pending', input: {} }),
        toolPart({ status: 'running', input: { command: 'echo hi' } }),
        toolPart({ status: 'completed', input: { command: 'echo hi' }, output: 'hi' }),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      const activities = activitiesOf(events);

      assert.equal(activities.length, 1);
      assert.equal(activities[0]?.tool, 'bash');
      assert.equal(activities[0]?.target, 'echo hi');

      const output = events.find((event) => event.type === 'activity_output');
      assert.equal(output?.type === 'activity_output' ? output.output : '', 'hi');
    },
  );
});

test('the session is reported before any answer text', async () => {
  await withFakeOpenCode(
    { events: [assistantMessage, delta('prt-1', 'text'), idle] },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      const first = events[0];

      // A run cut short still has to leave an id to continue from.
      assert.equal(first?.type, 'session');
      assert.equal(first?.type === 'session' ? first.id : '', SESSION);
    },
  );
});

test('a session to continue is prompted directly', async () => {
  // The turn ends on an event for the session being continued, not for a new one.
  await withFakeOpenCode({ events: [idleFor('ses-old')] }, async (engine, fake) => {
    await collect(engine.prompt('hi', { ...base, resume: 'ses-old' }));

    assert.ok(
      fake.requests.some(
        (request) => request.path === '/session/ses-old/prompt_async' && request.method === 'POST',
      ),
    );
    // Continuing an existing session must not create another one.
    assert.ok(!fake.requests.some((request) => request.path === '/session'));
  });
});

test('a stale session falls back to answering fresh', async () => {
  await withFakeOpenCode(
    { events: [assistantMessage, delta('prt-1', 'fresh answer'), idle], unknown: ['ses-gone'] },
    async (engine, fake) => {
      const events = await collect(engine.prompt('hi', { ...base, resume: 'ses-gone' }));

      // Sessions live in opencode and can be pruned at any time, so this is expected
      // rather than exceptional.
      assert.equal(textOf(events), 'fresh answer');
      assert.equal(
        events.filter((event) => event.type === 'error').length,
        0,
        'a pruned session is not a failure',
      );
      assert.ok(fake.requests.some((request) => request.path === '/session'));
    },
  );
});

test('an ask reaches the caller with everything it covers', async () => {
  const asks: EnginePermissionRequest[] = [];

  await withFakeOpenCode(
    {
      events: [
        assistantMessage,
        {
          type: 'permission.asked',
          properties: {
            sessionID: SESSION,
            id: 'per-1',
            permission: 'bash',
            patterns: ['curl example.com', 'echo done'],
            metadata: { command: 'curl example.com; echo done' },
            always: ['curl *', 'echo *'],
          },
        },
        idle,
      ],
    },
    async (engine, fake) => {
      await collect(
        engine.prompt('hi', {
          ...base,
          requestPermission: async (request) => {
            asks.push(request);
            return 'once';
          },
        }),
      );

      const ask = asks[0];
      assert.ok(ask !== undefined);
      assert.equal(ask.tool, 'bash');
      assert.equal(ask.target, 'curl example.com; echo done');
      // One ask can cover several commands, and hiding the rest would mean agreeing
      // to more than was shown. See ADR-022.
      assert.deepEqual(ask.details, ['curl example.com', 'echo done']);
      // Reworded into the rule syntax grants are stored in, since opencode offers
      // bare globs with the tool left implied.
      assert.deepEqual(ask.suggestions, ['bash(curl *)', 'bash(echo *)']);

      assert.deepEqual(fake.replies, [{ permissionId: 'per-1', response: 'once' }]);
    },
  );
});

test('each decision is sent back as it stands', async () => {
  for (const decision of ['once', 'always', 'reject'] as const) {
    await withFakeOpenCode(
      {
        events: [
          {
            type: 'permission.asked',
            properties: { sessionID: SESSION, id: 'per-1', permission: 'bash', patterns: [] },
          },
          idle,
        ],
      },
      async (engine, fake) => {
        await collect(engine.prompt('hi', { ...base, requestPermission: async () => decision }));

        // 'always' is passed through rather than flattened, because opencode has a
        // lasting grant of its own and the machine records one too.
        assert.deepEqual(fake.replies, [{ permissionId: 'per-1', response: decision }]);
      },
    );
  }
});

test('an ask nobody can answer is refused', async () => {
  await withFakeOpenCode(
    {
      events: [
        {
          type: 'permission.asked',
          properties: { sessionID: SESSION, id: 'per-1', permission: 'bash', patterns: [] },
        },
        idle,
      ],
    },
    async (engine, fake) => {
      // No requestPermission, so nobody is listening. Running a tool call nobody
      // agreed to is the one outcome worth ruling out.
      await collect(engine.prompt('hi', base));

      assert.deepEqual(fake.replies, [{ permissionId: 'per-1', response: 'reject' }]);
    },
  );
});

test('a caller that throws refuses the call', async () => {
  await withFakeOpenCode(
    {
      events: [
        {
          type: 'permission.asked',
          properties: { sessionID: SESSION, id: 'per-1', permission: 'bash', patterns: [] },
        },
        idle,
      ],
    },
    async (engine, fake) => {
      await collect(
        engine.prompt('hi', {
          ...base,
          requestPermission: async () => {
            throw new Error('the browser went away');
          },
        }),
      );

      assert.deepEqual(fake.replies, [{ permissionId: 'per-1', response: 'reject' }]);
    },
  );
});

test('a refusal decided by the engine alone is reported', async () => {
  await withFakeOpenCode(
    {
      events: [
        assistantMessage,
        toolPart({ status: 'running', input: { command: 'rm -rf /' } }),
        toolPart({ status: 'error', input: { command: 'rm -rf /' }, error: 'rejected permission' }),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));

      // Only when nobody could be asked. With asks on this comes from a decision the
      // caller made and already knows the reason for.
      assert.deepEqual(blockedOf(events), [
        { type: 'blocked', tool: 'bash', reason: 'rejected permission' },
      ]);
    },
  );
});

test('a tool that merely failed is not reported as refused', async () => {
  await withFakeOpenCode(
    {
      events: [
        assistantMessage,
        toolPart({ status: 'running', input: { command: 'ls /nope' } }),
        toolPart({
          status: 'error',
          input: { command: 'ls /nope' },
          error: 'No such file or directory',
        }),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));

      assert.deepEqual(blockedOf(events), []);
      // The failure is still shown as the call's output, which is where it belongs.
      assert.ok(events.some((event) => event.type === 'activity_output'));
    },
  );
});

test('an idle session ends the turn', async () => {
  await withFakeOpenCode({ events: [idle] }, async (engine) => {
    const events = await collect(engine.prompt('hi', base));
    const done = events.find((event) => event.type === 'done');

    assert.equal(done?.type === 'done' ? done.exitCode : -1, 0);
  });
});

test('a session error ends the turn as a failure', async () => {
  await withFakeOpenCode(
    {
      events: [
        { type: 'session.error', properties: { sessionID: SESSION, error: 'out of credit' } },
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));
      const failure = events.find((event) => event.type === 'error');

      assert.equal(failure?.type === 'error' ? failure.message : '', 'out of credit');
      const done = events.find((event) => event.type === 'done');
      assert.equal(done?.type === 'done' ? done.exitCode : -1, 1);
    },
  );
});

test('another session on the same server is not this turn', async () => {
  await withFakeOpenCode(
    {
      events: [
        {
          type: 'message.updated',
          properties: { sessionID: 'ses-other', info: { id: 'msg-x', role: 'assistant' } },
        },
        {
          type: 'message.part.delta',
          properties: {
            sessionID: 'ses-other',
            messageID: 'msg-x',
            partID: 'prt-x',
            field: 'text',
            delta: 'not ours',
          },
        },
        assistantMessage,
        delta('prt-1', 'ours'),
        idle,
      ],
    },
    async (engine) => {
      const events = await collect(engine.prompt('hi', base));

      // One server can host several sessions, so anything else would leak another
      // conversation's answer into this one.
      assert.equal(textOf(events), 'ours');
    },
  );
});

test('a chosen model is split the way opencode wants it', async () => {
  await withFakeOpenCode({ events: [idle] }, async (engine, fake) => {
    await collect(engine.prompt('hi', { ...base, model: 'anthropic/claude-sonnet-4' }));

    const prompt = fake.requests.find((request) => request.path.endsWith('/prompt_async'));
    assert.deepEqual((prompt?.body as { model?: unknown }).model, {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
  });
});

test('a server that cannot start is reported, not thrown', async () => {
  const engine = new OpenCodeEngine({
    startServer: async () => {
      throw new Error('opencode exited with code 1');
    },
  });

  const events = await collect(engine.prompt('hi', base));
  const failure = events.find((event) => event.type === 'error');

  // The browser is waiting for an answer either way, so a dead server has to arrive
  // as a failed turn rather than as an exception nobody catches.
  assert.match(failure?.type === 'error' ? failure.message : '', /exited with code 1/);
  assert.ok(events.some((event) => event.type === 'done'));
});

test('models are read from the engine and junk lines dropped', async () => {
  const script = `#!/usr/bin/env node
process.stdout.write('anthropic/claude-sonnet-4\\nnot a model\\nopenai/gpt-5\\n');
`;

  await withFakeEngine('opencode', script, async () => {
    assert.deepEqual(await new OpenCodeEngine().listModels(), [
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ]);
  });
});

test('a missing engine reports unavailable instead of throwing', async () => {
  await withEmptyPath(async () => {
    const engine = new OpenCodeEngine();

    assert.equal(await engine.isAvailable(), false);
    assert.deepEqual(await engine.listModels(), []);
  });
});
