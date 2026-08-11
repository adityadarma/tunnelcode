import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, getJson, postJson, withServer } from './server-helpers.ts';
import type { Recorder } from './server-helpers.ts';

/**
 * Importing an agent session more than once.
 *
 * An engine hands out its own tool-call ids, and reading the same session file
 * again replays exactly the same ones. Storing one as the activity row key made
 * the second import of a session collide with the rows the first one wrote, so
 * these tests import twice and check that two independent conversations come out.
 */

interface CliEvent {
  type: string;
  requestId?: string;
  sessionId?: string;
}

interface ImportedActivity {
  id: string;
  tool: string;
  target: string | null;
  output: string | null;
}

const registration = {
  type: 'register',
  code: 'ABCDEFGH',
  runId: 'one-run-of-the-cli-importing-sessions',
  deviceId: 'device-1',
  deviceName: 'Test Mac',
  workspace: '/work',
  engines: [{ name: 'kiro', models: ['kiro/auto'] }],
};

interface Paired {
  cli: Recorder<CliEvent>;
  sessionId: string;
}

async function pair(baseUrl: string): Promise<Paired> {
  const cli = await connect<CliEvent>(baseUrl, '/ws/cli');
  cli.send(registration);
  await cli.waitFor((events) => events.some((event) => event.type === 'registered'));

  const request = await postJson(baseUrl, '/api/pair', { code: registration.code });
  await cli.waitFor((events) => events.some((event) => event.type === 'pair_request'));

  cli.send({ type: 'approve', requestId: request.body['requestId'] });
  await cli.waitFor((events) => events.some((event) => event.type === 'paired'));

  const status = await getJson(baseUrl, `/api/pair/${String(request.body['requestId'])}/status`);

  return { cli, sessionId: String(status.body['sessionId']) };
}

/**
 * Runs one import, standing in for the CLI that reads the session file.
 *
 * The same content is returned every time it is asked for the same session,
 * because that is what reading a file twice does.
 */
async function importSession(
  baseUrl: string,
  paired: Paired,
  agentSessionId: string,
  activities: readonly ImportedActivity[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  const seen = paired.cli.events.length;

  const pending = postJson(baseUrl, `/api/sessions/${paired.sessionId}/conversations/import`, {
    engine: 'kiro',
    sessionId: agentSessionId,
  });

  await paired.cli.waitFor((events) =>
    events.slice(seen).some((event) => event.type === 'import_session_request'),
  );

  const asked = paired.cli.events
    .slice(seen)
    .find((event) => event.type === 'import_session_request');

  paired.cli.send({
    type: 'import_session_response',
    requestId: asked?.requestId,
    sessionId: agentSessionId,
    engineSessionId: null,
    messages: [
      { role: 'user', content: 'Coba lihat file readme' },
      { role: 'assistant', content: 'It explains how to pair.' },
    ],
    activities,
  });

  return pending;
}

/** The two tool calls the reported session carried. */
const toolCalls: readonly ImportedActivity[] = [
  { id: 'tooluse_read_readme', tool: 'fsRead', target: 'README.md', output: '# tunnelcode' },
  { id: 'tooluse_list_dir', tool: 'listDirectory', target: '.', output: 'README.md' },
];

test('the same agent session can be imported twice', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);

    const first = await importSession(baseUrl, paired, 'coba-lihat-file-readme', toolCalls);
    const second = await importSession(baseUrl, paired, 'coba-lihat-file-readme', toolCalls);

    assert.equal(first.status, 201);
    // The second import used to fail on the tool-call ids the first one had already
    // written, which is the whole bug.
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(String(first.body['id']), String(second.body['id']));

    const firstTranscript = await getJson(
      baseUrl,
      `/api/conversations/${String(first.body['id'])}/messages`,
    );
    const secondTranscript = await getJson(
      baseUrl,
      `/api/conversations/${String(second.body['id'])}/messages`,
    );

    const read = (response: { body: Record<string, unknown> }): { id: string; tool: string }[] =>
      response.body['activities'] as { id: string; tool: string }[];

    // Each conversation carries the whole session rather than half of it, and the
    // two sets share no row, so deleting one import cannot empty the other.
    assert.deepEqual(
      read(firstTranscript).map((item) => item.tool),
      ['fsRead', 'listDirectory'],
    );
    assert.deepEqual(
      read(secondTranscript).map((item) => item.tool),
      ['fsRead', 'listDirectory'],
    );

    const ids = [...read(firstTranscript), ...read(secondTranscript)].map((item) => item.id);
    assert.equal(new Set(ids).size, 4);

    // The engine's tool-call id is not the row key, so nothing addresses an
    // imported activity by it.
    for (const id of ids) {
      assert.equal(
        toolCalls.some((call) => call.id === id),
        false,
      );
    }

    paired.cli.close();
  });
});

test('two agent sessions that share a tool-call id can both be imported', async () => {
  await withServer(async ({ baseUrl }) => {
    const paired = await pair(baseUrl);

    // Engines number tool calls per session, so the same id turning up in two
    // unrelated sessions is ordinary rather than a coincidence to ignore.
    const first = await importSession(baseUrl, paired, 'session-a', [
      { id: 'call_1', tool: 'fsRead', target: 'a.ts', output: 'a' },
    ]);
    const second = await importSession(baseUrl, paired, 'session-b', [
      { id: 'call_1', tool: 'fsWrite', target: 'b.ts', output: 'b' },
    ]);

    assert.equal(first.status, 201);
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const transcript = await getJson(
      baseUrl,
      `/api/conversations/${String(second.body['id'])}/messages`,
    );
    const activities = transcript.body['activities'] as { tool: string; output: string }[];

    // The second session keeps its own call rather than being handed the first
    // one's row.
    assert.deepEqual(
      activities.map((item) => [item.tool, item.output]),
      [['fsWrite', 'b']],
    );

    paired.cli.close();
  });
});
