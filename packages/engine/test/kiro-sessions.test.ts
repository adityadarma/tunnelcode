import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KiroEngine } from '../dist/adapters/kiro.js';

/**
 * Fixtures built in the shape kiro-cli 2.16.0 writes on disk: one flat directory,
 * `~/.kiro/sessions/cli/`, holding a `<uuid>.json` sidecar of metadata beside a
 * `<uuid>.jsonl` transcript of records. The third file a real session has,
 * `<uuid>.history`, is REPL input rather than conversation and is never read, so
 * nothing here writes one.
 *
 * The store is found from the home directory, so the tests point the process at a
 * temporary one instead of touching the real sessions on this machine.
 */
async function withStore<T>(
  build: (dir: string) => Promise<void>,
  run: (engine: KiroEngine) => Promise<T>,
): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-kiro-home-'));

  await build(join(home, '.kiro', 'sessions', 'cli'));

  // Both, because the home directory is read from HOME on Linux and macOS but from
  // USERPROFILE on Windows. Setting only one would leave the other platform reading
  // the developer's own session history.
  const restore = (['HOME', 'USERPROFILE'] as const).map((name) => {
    const previous = process.env[name];
    process.env[name] = home;

    return (): void => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = previous;
      }
    };
  });

  try {
    return await run(new KiroEngine());
  } finally {
    for (const undo of restore) {
      undo();
    }

    await rm(home, { recursive: true, force: true });
  }
}

/** Writes one session: its sidecar, and its transcript unless there is none. */
async function session(
  dir: string,
  id: string,
  sidecar: Record<string, unknown>,
  records: unknown[] | undefined,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ session_id: id, ...sidecar }), 'utf8');

  if (records !== undefined) {
    await writeFile(
      join(dir, `${id}.jsonl`),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      'utf8',
    );
  }
}

function prompt(text: string): unknown {
  return {
    version: 'v1',
    kind: 'Prompt',
    data: {
      message_id: 'm-prompt',
      content: [{ kind: 'text', data: text }],
      meta: { timestamp: 1785769346 },
    },
  };
}

function assistant(text: string, blocks: unknown[] = []): unknown {
  return {
    version: 'v1',
    kind: 'AssistantMessage',
    data: { message_id: 'm-assistant', content: [{ kind: 'text', data: text }, ...blocks] },
  };
}

test('reads a sidecar and its transcript into a summary', async () => {
  const summaries = await withStore(
    async (dir) => {
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000001',
        {
          cwd: '/work/project',
          created_at: '2026-08-04T01:00:41.871918Z',
          updated_at: '2026-08-08T13:46:58.740184Z',
          title: 'Look at the readme',
        },
        [prompt('look at the readme'), assistant('It describes the project.')],
      );
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.deepEqual(summaries, [
    {
      id: 'aaaa1111-0000-0000-0000-000000000001',
      title: 'Look at the readme',
      lastActiveAt: '2026-08-08T13:46:58.740Z',
      messageCount: 2,
      preview: 'It describes the project.',
    },
  ]);
});

test('titles a session by its first prompt when the sidecar has no title', async () => {
  const summaries = await withStore(
    async (dir) => {
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000002',
        { cwd: '/work/project', updated_at: '2026-08-08T11:39:53.480353Z', title: null },
        [prompt('build this project'), assistant('Done.')],
      );
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.title, 'build this project');
});

test('offers only the sessions opened in this workspace, newest first', async () => {
  const summaries = await withStore(
    async (dir) => {
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000003',
        { cwd: '/work/project', updated_at: '2026-08-01T00:00:00Z', title: 'older' },
        [prompt('one'), assistant('first')],
      );
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000004',
        { cwd: '/work/project', updated_at: '2026-08-02T00:00:00Z', title: 'newer' },
        [prompt('two'), assistant('second')],
      );
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000005',
        { cwd: '/work/elsewhere', updated_at: '2026-08-03T00:00:00Z', title: 'other workspace' },
        [prompt('three'), assistant('third')],
      );
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.deepEqual(
    summaries.map((summary) => summary.title),
    ['newer', 'older'],
  );
});

test('skips a sidecar whose transcript is gone', async () => {
  const summaries = await withStore(
    async (dir) => {
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000006',
        { cwd: '/work/project', updated_at: '2026-08-02T00:00:00Z', title: 'orphan' },
        undefined,
      );
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000007',
        { cwd: '/work/project', updated_at: '2026-08-01T00:00:00Z', title: 'whole' },
        [prompt('one'), assistant('first')],
      );
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.deepEqual(
    summaries.map((summary) => summary.title),
    ['whole'],
  );
});

test('falls back to the file time when the sidecar reports no last activity', async () => {
  const summaries = await withStore(
    async (dir) => {
      await session(dir, 'aaaa1111-0000-0000-0000-000000000008', { cwd: '/work/project' }, [
        prompt('one'),
      ]);
      const when = new Date('2026-07-04T09:00:00.000Z');
      await utimes(join(dir, 'aaaa1111-0000-0000-0000-000000000008.json'), when, when);
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.equal(summaries[0]?.lastActiveAt, '2026-07-04T09:00:00.000Z');
});

test('reports no sessions when the store was never written', async () => {
  const summaries = await withStore(
    async () => {
      // Nothing: the home directory exists, the session store inside it does not.
    },
    async (engine) => engine.listLocalSessions('/work/project'),
  );

  assert.deepEqual(summaries, []);
});

test('reads messages, tool calls and the id to resume from', async () => {
  const content = await withStore(
    async (dir) => {
      await session(
        dir,
        'aaaa1111-0000-0000-0000-000000000009',
        { cwd: '/work/project', updated_at: '2026-08-08T13:46:58.740184Z', title: 'readme' },
        [
          prompt('look at the readme'),
          assistant('', [
            {
              kind: 'toolUse',
              data: {
                toolUseId: 'tooluse_one',
                name: 'read',
                input: { operations: [{ mode: 'Line', path: '/work/project/README.md' }] },
              },
            },
          ]),
          {
            version: 'v1',
            kind: 'ToolResults',
            data: {
              message_id: 'm-results',
              content: [
                {
                  kind: 'toolResult',
                  data: {
                    toolUseId: 'tooluse_one',
                    content: [{ kind: 'text', data: '# Project' }],
                    status: 'success',
                  },
                },
              ],
            },
          },
          assistant('It describes the project.'),
        ],
      );
    },
    async (engine) => engine.readSessionContent('aaaa1111-0000-0000-0000-000000000009'),
  );

  assert.equal(content.engineSessionId, 'aaaa1111-0000-0000-0000-000000000009');
  assert.deepEqual(content.messages, [
    { role: 'user', content: 'look at the readme' },
    { role: 'assistant', content: 'It describes the project.' },
  ]);
  assert.deepEqual(content.activities, [
    {
      id: 'tooluse_one',
      tool: 'read',
      target: '/work/project/README.md',
      output: '# Project',
    },
  ]);
});

test('reports an id that names no session as not found', async () => {
  await withStore(
    async (dir) => {
      await session(dir, 'aaaa1111-0000-0000-0000-000000000010', { cwd: '/work/project' }, [
        prompt('one'),
      ]);
    },
    async (engine) => {
      await assert.rejects(() => engine.readSessionContent('no-such-session'), {
        message: /not found/i,
      });
    },
  );
});
