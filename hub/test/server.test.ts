import { strict as assert } from 'node:assert';
import { get, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { normalise } from '../src/claude-code/normalise.ts';
import { stableId } from '../src/claude-code/source.ts';
import { Colony } from '../src/colony.ts';
import { createHub } from '../src/server.ts';
import { emptyUsage, type SourceAdapter } from '../src/sources.ts';
import { Store } from '../src/store.ts';

// A stand-in for Claude Code, so these tests cover the hub and not transcript reading.
const claude: SourceAdapter = {
  id: 'claude-code',
  ingest: (payload, at) => normalise(payload, { at: at.toISOString(), system: 'mira' }),
  title: (s) => (s.transcript ? 'Hub work' : undefined),
  story: (s, { helper }) => (s.transcript ? { sessionId: s.id, helperId: helper, usage: emptyUsage(), turns: [], earlier: 0 } : null),
  followUp: (event, emit) => {
    if (event.type !== 'turn.ended') return;
    const { status, ...rest } = event;
    emit({ ...rest, id: stableId(`usage:${event.id}`), type: 'usage.reported', usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 } });
  },
};
const store = new Store(':memory:');
const colony = new Colony();
const hub = createHub({ store, colony, sources: [claude], placeFor: () => ({ system: 'mira' }), permissionWaitMs: 5000 });
let base = '';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const sessions = async () => (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ id: string; status: string; title?: string; usage?: { tokens: number; costUsd: number } }>; pending: Array<{ id: string; summary?: string }> };
const firstPending = async () => {
  for (let i = 0; i < 50; i++) {
    const [prompt] = (await sessions()).pending;
    if (prompt) return prompt;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('no prompt arrived');
};
const statusOf = async (id: string) => (await sessions()).sessions.find((s) => s.id === id)?.status;

describe('hub server', () => {
  before(async () => {
    await new Promise<void>((done) => hub.server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  });
  after(() => {
    hub.close();
    store.close();
  });

  it('turns a hook payload into a stored event and a live status', async () => {
    const res = await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: 'C:\\code\\mira', prompt: 'secret plans' });
    assert.equal(res.status, 204);
    assert.equal(await statusOf('s-1'), 'working');
    const events = (await (await fetch(`${base}/api/events?limit=5`)).json()) as unknown[];
    assert.doesNotMatch(JSON.stringify(events), /secret plans/);
  });

  it('refuses requests from web pages on other sites', async () => {
    const res = await post('/ingest/claude-code', { hook_event_name: 'Stop', session_id: 's-evil' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(await statusOf('s-evil'), undefined);
  });

  it('refuses anything a browser marks as coming from another site', async () => {
    const res = await fetch(`${base}/api/sessions/s-1/story`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  it('refuses requests addressed to another host name', async () => {
    const { port } = hub.server.address() as AddressInfo;
    const status = await new Promise<number>((done) => {
      request({ host: '127.0.0.1', port, path: '/api/sessions', headers: { host: 'evil.example' } }, (res) => { res.resume(); done(res.statusCode ?? 0); }).end();
    });
    assert.equal(status, 403);
  });

  it('lets the terminal prompt appear at once when nobody is watching', async () => {
    const res = await post('/hooks/permission', { hook_event_name: 'PermissionRequest', session_id: 's-2', cwd: 'C:\\code\\mira', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.equal(res.status, 204);
    assert.equal(await statusOf('s-2'), 'needs-me');
  });

  it('holds a prompt for an answer while Mira is open', async () => {
    const viewer = get(`${base}/api/stream`);
    await new Promise((done) => viewer.on('response', done));
    const hookReply = post('/hooks/permission', { hook_event_name: 'PermissionRequest', session_id: 's-3', cwd: 'C:\\code\\mira', tool_name: 'Bash', tool_input: { command: 'git push' } });

    const prompt = await firstPending();
    assert.equal(prompt.summary, 'git push');
    assert.equal((await post(`/api/prompts/${prompt.id}`, { decision: 'allow' })).status, 204);

    const res = await hookReply;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal(await statusOf('s-3'), 'working');
    viewer.destroy();
  });

  it('hands a prompt back to the terminal when asked to', async () => {
    const viewer = get(`${base}/api/stream`);
    await new Promise((done) => viewer.on('response', done));
    const hookReply = post('/hooks/permission', { hook_event_name: 'PermissionRequest', session_id: 's-4', cwd: 'C:\\code\\mira', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    const prompt = await firstPending();
    assert.equal((await post(`/api/prompts/${prompt.id}`, { decision: 'terminal' })).status, 204);
    assert.equal((await hookReply).status, 204);
    assert.equal(await statusOf('s-4'), 'needs-me');
    assert.equal((await post(`/api/prompts/${prompt.id}`, { decision: 'allow' })).status, 404);
    viewer.destroy();
  });

  it('titles sessions from their transcripts', async () => {
    await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-5', cwd: 'C:\\code\\mira', transcript_path: 'C:\\t\\s-5.jsonl' });
    assert.equal((await sessions()).sessions.find((s) => s.id === 's-5')?.title, 'Hub work');
  });

  it("tells a session's story through its source, and 404s for anything else", async () => {
    const story = await (await fetch(`${base}/api/sessions/s-5/story?helper=a1`)).json();
    assert.deepEqual(story, { sessionId: 's-5', helperId: 'a1', usage: emptyUsage(), turns: [], earlier: 0 });
    assert.equal((await fetch(`${base}/api/sessions/nobody/story`)).status, 404);
    assert.equal((await fetch(`${base}/api/sessions/s-1/story`)).status, 404); // s-1 has no transcript
    assert.equal((await post('/ingest/not-a-source', { hook_event_name: 'Stop', session_id: 's-x' })).status, 404);
  });

  it('records what a source reports after an event, such as token use', async () => {
    await post('/ingest/claude-code', { hook_event_name: 'Stop', session_id: 's-6', cwd: 'C:\\code\\mira', prompt_id: 'p-1' });
    assert.deepEqual((await sessions()).sessions.find((s) => s.id === 's-6')?.usage, { tokens: 30, costUsd: 0.5 });
  });

  it('serves the status board', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await res.text(), /<title>Mira<\/title>/);
  });
});
