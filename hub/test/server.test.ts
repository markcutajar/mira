import { strict as assert } from 'node:assert';
import { get, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { normalise } from '../src/claude-code/normalise.ts';
import { stableId } from '../src/claude-code/source.ts';
import { Roster } from '../src/roster.ts';
import { createHub } from '../src/server.ts';
import { emptyUsage, type SourceAdapter } from '../src/sources.ts';
import { Store } from '../src/store.ts';
import { WebSocket } from 'ws';

// A stand-in for Claude Code, so these tests cover the hub and not transcript reading.
const given = new Map<string, string>();
const claude: SourceAdapter = {
  id: 'claude-code',
  ingest: (payload, at) => normalise(payload, { at: at.toISOString(), system: 'mira' }),
  title: (s) => given.get(s.id) ?? (s.transcript ? 'Hub work' : undefined),
  rename: (s, name) => (s.transcript ? Boolean(given.set(s.id, name)) : false),
  story: (s, { helper }) => (s.transcript ? { sessionId: s.id, helperId: helper, usage: emptyUsage(), turns: [], earlier: 0 } : null),
  continueAt: (s) => (s.cwd ? { folder: s.cwd, link: `vscode://claude/open?session=${s.id}` } : null),
  // A harmless program stands in for `claude --resume`.
  terminalFor: (s) => (s.cwd ? { file: process.execPath, args: ['-e', "process.stdout.write('hello from mira')"], cwd: process.cwd(), title: 'hello' } : null),
  startAt: (_folder, prompt) => ({ link: `vscode://claude/open?prompt=${prompt ?? ''}` }),
  followUp: (event, emit) => {
    if (event.type !== 'turn.ended') return;
    const { status, ...rest } = event;
    emit({ ...rest, id: stableId(`usage:${event.id}`), type: 'usage.reported', usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.5 } });
  },
};
// A stand-in for VS Code, so no test ever opens a window.
const opened: string[] = [];
const editor = { target: (folder: string) => ({ link: `vscode://file/${folder}`, name: 'mira (Workspace)' }), open: (link: string) => void opened.push(link) };
const store = new Store(':memory:');
const roster = new Roster();
const hub = createHub({ store, roster, sources: [claude], placeFor: (cwd) => ({ system: 'mira', root: cwd }), permissionWaitMs: 5000, editor, editorDelayMs: 0, growth: { get: (system) => (system === 'mira' ? { commits: 12, docs: 3, workshop: 2, library: 2 } : undefined) } });
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

  it('names the editor window for a session, then opens the session there', async () => {
    const target = await (await fetch(`${base}/api/sessions/s-5/editor`)).json();
    assert.deepEqual(target, { link: 'vscode://file/C:\\code\\mira', name: 'mira (Workspace)' });
    assert.equal((await post('/api/sessions/s-5/editor', {})).status, 204);
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(opened, ['vscode://claude/open?session=s-5']);
    assert.equal((await fetch(`${base}/api/sessions/nobody/editor`)).status, 404);
  });

  it('runs a terminal for a session and streams it to the page, but to no other site', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/sessions/s-5/terminal`)).json(), { available: true, running: false });
    const address = `${base.replace('http', 'ws')}/api/sessions/s-5/terminal?cols=80&rows=24`;
    const page = new WebSocket(address, { headers: { Origin: base } });
    const seen: Array<{ type: string; data?: string; running?: boolean; exitCode?: number | null }> = [];
    const ended = new Promise<void>((done) => page.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as (typeof seen)[number];
      seen.push(message);
      if (message.type === 'state' && message.running === false && message.exitCode === 0) done();
    }));
    await new Promise((done) => page.on('open', done));
    page.send(JSON.stringify({ type: 'start' }));
    await ended;
    assert.match(seen.filter((m) => m.type === 'output').map((m) => m.data).join(''), /hello from mira/);
    page.close();
    const stranger = new WebSocket(address, { headers: { Origin: 'https://evil.example' } });
    const refused = await new Promise((done) => {
      stranger.on('unexpected-response', (_req, res) => done(res.statusCode));
      stranger.on('error', () => done('error'));
    });
    assert.equal(refused, 403);
  });

  it('starts a new session in a project, with the prompt typed in for me', async () => {
    const target = await (await fetch(`${base}/api/systems/mira/start`)).json();
    assert.deepEqual(target, { link: 'vscode://file/C:\\code\\mira', name: 'mira (Workspace)', folder: 'C:\\code\\mira' });
    assert.equal((await post('/api/systems/mira/start', { prompt: '  Fix the login loop  ' })).status, 204);
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(opened.at(-1), 'vscode://claude/open?prompt=Fix the login loop');
    assert.equal((await post('/api/systems/mira/start', { prompt: 'x'.repeat(1501) })).status, 400);
    assert.equal((await fetch(`${base}/api/systems/${encodeURIComponent('not here')}/start`)).status, 404);
  });

  it('records what a source reports after an event, such as token use', async () => {
    await post('/ingest/claude-code', { hook_event_name: 'Stop', session_id: 's-6', cwd: 'C:\\code\\mira', prompt_id: 'p-1' });
    assert.deepEqual((await sessions()).sessions.find((s) => s.id === 's-6')?.usage, { tokens: 30, costUsd: 0.5 });
  });

  it('serves the page: the sky with the board down its left', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const page = await res.text();
    assert.match(page, /<title>Mira<\/title>/);
    assert.match(page, /id="sidebar"/);
    const script = await fetch(`${base}/markdown.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.equal((await fetch(`${base}/toString`)).status, 404);
  });

  it('serves the page at its old sky address too, its modules with their types stripped, and Phaser', async () => {
    assert.match(await (await fetch(`${base}/sky`)).text(), /id="sidebar"/);
    const module = await fetch(`${base}/shared/format.ts`);
    assert.match(module.headers.get('content-type') ?? '', /javascript/);
    const code = await module.text();
    assert.match(code, /export const esc/);
    assert.doesNotMatch(code, /import type|: BoardSession\)/);
    assert.match((await fetch(`${base}/shared/mira.css`)).headers.get('content-type') ?? '', /css/);
    assert.equal((await fetch(`${base}/vendor/phaser.js`)).status, 200);
    assert.equal((await fetch(`${base}/shared/nope.ts`)).status, 404);
    assert.equal((await fetch(`${base}/shared/..%2Fsrc%2Fmain.ts`)).status, 404);
    assert.equal((await fetch(`${base}/src/main.ts`)).status, 404);
  });

  it('lists projects in the order they first appeared', async () => {
    const { systems } = (await (await fetch(`${base}/api/systems`)).json()) as { systems: Array<{ name: string }> };
    assert.deepEqual(systems.map((s) => s.name), ['mira']);
  });

  it('sends each project with its recent commits', async () => {
    const { systems } = (await (await fetch(`${base}/api/systems`)).json()) as { systems: Array<{ growth?: unknown }> };
    assert.deepEqual(systems[0]?.growth, { commits: 12, docs: 3, workshop: 2, library: 2 });
  });

  it('renames projects in Mira, and sessions where their source keeps the name', async () => {
    const put = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put('/api/names/system/mira', { name: ' Mira ' })).status, 204);
    assert.equal((await put('/api/names/session/s-5', { name: 'The hub' })).status, 204);
    const { systems } = (await (await fetch(`${base}/api/systems`)).json()) as { systems: Array<{ name: string; label?: string }> };
    assert.deepEqual(systems.map((s) => [s.name, s.label]), [['mira', 'Mira']]);
    assert.equal(given.get('s-5'), 'The hub');
    assert.equal((await sessions()).sessions.find((s) => s.id === 's-5')?.title, 'The hub');
    assert.equal((await put('/api/names/session/s-5', { name: '' })).status, 400); // Claude Code has no way back
    given.delete('s-5');
    assert.equal((await sessions()).sessions.find((s) => s.id === 's-5')?.title, 'Hub work');
    assert.equal((await put('/api/names/system/mira', { name: 'x'.repeat(81) })).status, 400);
    assert.equal((await post('/api/names/system/mira', { name: 'Mira' })).status, 405);
  });

  it('removes a session until something happens in it again', async () => {
    assert.equal((await post('/api/remove/session/s-5', {})).status, 204);
    assert.equal((await sessions()).sessions.some((s) => s.id === 's-5'), false);
    await new Promise((done) => setTimeout(done, 5));
    await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-5', cwd: 'C:\\code\\mira' });
    assert.equal((await sessions()).sessions.some((s) => s.id === 's-5'), true);
  });

  // Last, since it takes every test session off the board with it.
  it('removes a project with its sessions', async () => {
    assert.equal((await post('/api/remove/system/mira', {})).status, 204);
    const { systems } = (await (await fetch(`${base}/api/systems`)).json()) as { systems: unknown[] };
    assert.deepEqual(systems, []);
    assert.deepEqual((await sessions()).sessions, []);
  });
});
