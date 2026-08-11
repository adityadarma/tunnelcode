import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexEngine } from '../dist/adapters/codex.js';

/**
 * The rollout files belong to Codex, so every test runs against an isolated HOME.
 * Reading the real one would make the assertions depend on whatever the developer
 * happened to ask Codex last.
 */
async function withTempHome<T>(run: (sessions: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'tunnelcode-codex-home-'));

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
    return await run(join(home, '.codex', 'sessions'));
  } finally {
    for (const undo of restore) {
      undo();
    }
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Writes a rollout file where Codex writes them: under the day the session started,
 * named after its timestamp and id.
 */
async function writeRollout(
  sessions: string,
  day: readonly [string, string, string],
  sessionId: string,
  lines: readonly unknown[],
): Promise<string> {
  const dir = join(sessions, ...day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${day.join('-')}T00-00-00-${sessionId}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return path;
}

function meta(sessionId: string, cwd: string): unknown {
  return {
    timestamp: '2026-08-05T00:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: sessionId, id: sessionId, cwd },
  };
}

function userMessage(message: string): unknown {
  return { type: 'event_msg', payload: { type: 'user_message', message } };
}

function agentMessage(message: string): unknown {
  return { type: 'event_msg', payload: { type: 'agent_message', message } };
}

test('reads a rollout file into a summary', async () => {
  await withTempHome(async (sessions) => {
    await writeRollout(sessions, ['2026', '08', '05'], 'aaa', [
      meta('aaa', '/tmp/project'),
      userMessage('add a log viewer'),
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'unreadable' } },
      agentMessage('Done, the viewer is wired up.'),
    ]);

    const summaries = await new CodexEngine().listLocalSessions('/tmp/project');

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.id, 'aaa');
    assert.equal(summaries[0]?.title, 'add a log viewer');
    assert.equal(summaries[0]?.messageCount, 2);
    assert.equal(summaries[0]?.preview, 'Done, the viewer is wired up.');
    assert.match(summaries[0]?.lastActiveAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('offers only the sessions of the working directory it was asked about', async () => {
  await withTempHome(async (sessions) => {
    await writeRollout(sessions, ['2026', '08', '05'], 'mine', [
      meta('mine', '/tmp/project'),
      userMessage('mine'),
      agentMessage('yours'),
    ]);
    await writeRollout(sessions, ['2026', '08', '04'], 'theirs', [
      meta('theirs', '/tmp/other'),
      userMessage('theirs'),
      agentMessage('not yours'),
    ]);

    const summaries = await new CodexEngine().listLocalSessions('/tmp/project');

    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ['mine'],
    );
  });
});

test('skips a file it cannot read rather than reporting no sessions', async () => {
  await withTempHome(async (sessions) => {
    await writeRollout(sessions, ['2026', '08', '05'], 'good', [
      meta('good', '/tmp/project'),
      userMessage('still here'),
      agentMessage('answered'),
    ]);

    const dir = join(sessions, '2026', '08', '06');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rollout-2026-08-06T00-00-00-bad.jsonl'),
      'this is not JSON\n',
      'utf8',
    );

    const summaries = await new CodexEngine().listLocalSessions('/tmp/project');

    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ['good'],
    );
  });
});

test('reports a missing sessions directory as no history rather than as a failure', async () => {
  await withTempHome(async () => {
    assert.deepEqual(await new CodexEngine().listLocalSessions('/tmp/project'), []);
  });
});

test('reads the messages and tool calls of a session', async () => {
  await withTempHome(async (sessions) => {
    await writeRollout(sessions, ['2026', '08', '05'], 'aaa', [
      meta('aaa', '/tmp/project'),
      userMessage('what is here?'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call_1',
          arguments: JSON.stringify({ cmd: 'ls -la', workdir: '/tmp/project' }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_1', output: 'one file\n' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call_2',
          input:
            '*** Begin Patch\n*** Update File: /tmp/project/app.ts\n+const a = 1\n*** End Patch',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_2',
          output: JSON.stringify({ output: 'Success.\n', metadata: { exit_code: 0 } }),
        },
      },
      agentMessage('One file, and I patched it.'),
    ]);

    const content = await new CodexEngine().readSessionContent('aaa', '/tmp/project');

    assert.equal(content.engineSessionId, 'aaa');
    assert.deepEqual(content.messages, [
      { role: 'user', content: 'what is here?' },
      { role: 'assistant', content: 'One file, and I patched it.' },
    ]);
    assert.deepEqual(content.activities, [
      { id: 'call_1', tool: 'exec_command', target: 'ls -la', output: 'one file' },
      { id: 'call_2', tool: 'apply_patch', target: '/tmp/project/app.ts', output: 'Success.' },
    ]);
  });
});

test('reports an id no rollout file carries as not found', async () => {
  await withTempHome(async (sessions) => {
    await writeRollout(sessions, ['2026', '08', '05'], 'aaa', [
      meta('aaa', '/tmp/project'),
      userMessage('hello'),
      agentMessage('hi'),
    ]);

    await assert.rejects(() => new CodexEngine().readSessionContent('bbb', '/tmp/project'), {
      message: /Session not found: bbb/,
    });
  });
});
