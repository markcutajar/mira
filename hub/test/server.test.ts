import { strict as assert } from 'node:assert';
import { get, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { normalise } from '../src/claude-code/normalise.ts';
import { stableId } from '../src/claude-code/source.ts';
import { CONTRACT_VERSION } from '../../contracts/src/index.ts';
import { Roster } from '../src/roster.ts';
import { createHub } from '../src/server.ts';
import { emptyUsage, type SourceAdapter } from '../src/sources.ts';
import { Store } from '../src/store.ts';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalHost } from '../src/terminal-host.ts';
import { Terminals } from '../src/terminals.ts';

const WAITS = "process.stdout.write('ready'); process.stdin.on('data', (d) => { process.stdout.write('got ' + d); process.exit(0); })";

// A stand-in for Claude Code, so these tests cover the hub and not transcript reading.
const given = new Map<string, string>();
// Inboxes the hooks named (decision 46), and the messages sent into them.
const inboxes = new Set<string>();
const sent: Array<[string, string]> = [];
const claude: SourceAdapter = {
  id: 'claude-code',
  ingest: (payload, at, headers) => {
    if (headers?.['x-mira-inbox']) inboxes.add(String(payload.session_id));
    return normalise(payload, { at: at.toISOString(), system: 'mira' });
  },
  canMessage: (s) => inboxes.has(s.id),
  message: async (s, text) => (inboxes.has(s.id) ? (sent.push([s.id, text]), null) : "Mira doesn't know its inbox."),
  title: (s) => given.get(s.id) ?? (s.transcript ? 'Hub work' : undefined),
  rename: (s, name) => (s.transcript ? Boolean(given.set(s.id, name)) : false),
  story: (s, { helper }) => (s.transcript ? { sessionId: s.id, helperId: helper, usage: emptyUsage(), turns: [], earlier: 0 } : null),
  continueAt: (s) => (s.cwd ? { folder: s.cwd, link: `vscode://claude/open?session=${s.id}` } : null),
  // Harmless programs stand in for `claude --resume`: one says hello and ends, the other waits for me.
  terminalFor: (s) => (s.cwd ? { file: process.execPath, args: ['-e', s.id === 's-7' ? WAITS : "process.stdout.write('hello from mira')"], cwd: process.cwd(), title: 'hello' } : null),
  startAt: (_folder, prompt) => ({ link: `vscode://claude/open?prompt=${prompt ?? ''}` }),
  // Earlier conversations Claude Code still keeps; s-1 is on the board, so it's left out of history.
  history: () => [
    { sessionId: 'p-old', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-09-01T10:00:00.000Z', status: 'my-turn', transcript: 'C:\\t\\p-old.jsonl', title: 'Old work' },
    { sessionId: 'p-newer', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-09-20T10:00:00.000Z', status: 'working', transcript: 'C:\\t\\p-newer.jsonl', title: 'Newer work' },
    { sessionId: 's-1', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-09-02T10:00:00.000Z', status: 'my-turn', transcript: 'C:\\t\\s-1.jsonl' },
    { sessionId: 'elsewhere', system: 'garden', cwd: 'C:\\code\\garden', lastAt: '2026-09-03T10:00:00.000Z', status: 'my-turn', transcript: 'C:\\t\\elsewhere.jsonl' },
  ],
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
// The terminal host runs in this process here; terminals.test.ts runs it as a process of its own.
const home = mkdtempSync(join(tmpdir(), 'mira-hub-'));
let host: TerminalHost | undefined;
const terminals = () => new Terminals({ home, startHost: () => { if (!host) { host = new TerminalHost(); void host.listen(home); } } });
const options = { store, roster, sources: [claude], placeFor: (cwd: string | undefined) => ({ system: 'mira', root: cwd }), permissionWaitMs: 5000, editor, editorDelayMs: 0 };
const hub = createHub({ ...options, terminals: terminals(), growth: { get: (system) => (system === 'mira' ? { commits: 12, docs: 3, workshop: 2, library: 2 } : undefined) } });
let base = '';

async function listen(h: ReturnType<typeof createHub>): Promise<string> {
  await new Promise<void>((done) => h.server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(h.server.address() as AddressInfo).port}`;
}

// A page watching a session's terminal, as the browser does.
async function terminalPage(at: string, id: string) {
  const ws = new WebSocket(`${at.replace('http', 'ws')}/api/sessions/${id}/terminal?cols=80&rows=24`, { headers: { Origin: at } });
  const seen: Array<{ type: string; data?: string; running?: boolean; exitCode?: number | null }> = [];
  ws.on('message', (raw) => void seen.push(JSON.parse(String(raw)) as (typeof seen)[number]));
  const closed = new Promise((done) => ws.on('close', done));
  await new Promise((done) => ws.on('open', done));
  const output = () => seen.filter((m) => m.type === 'output').map((m) => m.data).join('');
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((done) => setTimeout(done, 50));
    assert.ok(ok(), `The terminal showed: ${JSON.stringify(output())}`);
  };
  return { ws, seen, closed, output, until, send: (message: unknown) => ws.send(JSON.stringify(message)) };
}

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
    host?.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
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

  it("lists a project's earlier conversations, newest first, and opens them like any other", async () => {
    store.add({ v: CONTRACT_VERSION, id: 'usage-p-old', at: '2026-09-01T10:00:00.000Z', source: 'claude-code', system: 'mira', actor: { kind: 'session', id: 'p-old' }, type: 'usage.reported', usage: { inputTokens: 100, outputTokens: 50, costUsd: 1.25 } });
    const history = async (query = '') => (await (await fetch(`${base}/api/systems/mira/history${query}`)).json()) as { sessions: Array<{ id: string; lastAt: string }>; more: boolean };
    const earlier = await history();
    assert.deepEqual(earlier.sessions.map((s) => s.id), ['p-newer', 'p-old']);
    assert.deepEqual(earlier.sessions[1], { id: 'p-old', source: 'claude-code', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-09-01T10:00:00.000Z', title: 'Old work', usage: { tokens: 150, costUsd: 1.25 } });
    const first = await history('?limit=1');
    assert.deepEqual([first.sessions.map((s) => s.id), first.more], [['p-newer'], true]);
    assert.deepEqual((await history(`?limit=1&before=${encodeURIComponent(first.sessions[0]?.lastAt ?? '')}`)).sessions.map((s) => s.id), ['p-old']);
    assert.equal((await fetch(`${base}/api/sessions/p-old/story`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/sessions/p-old/terminal`)).json(), { available: true, running: false });
    assert.equal((await sessions()).sessions.some((s) => s.id === 'p-old'), false); // opening it doesn't put it back on the board
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

  it('keeps a terminal running while the hub restarts, and picks up where it was', async () => {
    await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-7', cwd: 'C:\\code\\mira', transcript_path: 'C:\\t\\s-7.jsonl' });
    const before = createHub({ ...options, terminals: terminals() });
    const after = createHub({ ...options, terminals: terminals() });
    try {
      const page = await terminalPage(await listen(before), 's-7');
      page.send({ type: 'start' });
      await page.until(() => page.output().includes('ready'));
      before.close(); // the hub goes away, as in a restart
      await page.closed;
      const again = await listen(after);
      assert.deepEqual(await (await fetch(`${again}/api/sessions/s-7/terminal`)).json(), { available: true, running: true });
      const back = await terminalPage(again, 's-7');
      await back.until(() => back.output().includes('ready')); // what it showed before, replayed
      back.send({ type: 'input', data: 'x\r' });
      await back.until(() => back.output().includes('got x') && back.seen.some((m) => m.type === 'state' && m.exitCode === 0));
      back.ws.close();
    } finally {
      before.close();
      after.close();
    }
  });

  it('sends a running session my message through the inbox its hooks named', async () => {
    await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-msg', cwd: 'C:\\code\\mira' }, { 'X-Mira-Inbox': '\\\\.\\pipe\\cc-msg-0337493ba7fe34ce95f7a8621dad6624', 'X-Mira-Inbox-Token': 'a'.repeat(32) });
    await post('/ingest/claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's-quiet', cwd: 'C:\\code\\mira' });
    const listed = ((await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ id: string; canMessage?: boolean }> }).sessions;
    assert.equal(listed.find((s) => s.id === 's-msg')?.canMessage, true);
    assert.equal(listed.find((s) => s.id === 's-quiet')?.canMessage, undefined);
    assert.equal((await post('/api/sessions/s-msg/message', { text: '  Also check the tests\r\n ' })).status, 204);
    assert.deepEqual(sent.at(-1), ['s-msg', 'Also check the tests']);
    const refused = await post('/api/sessions/s-quiet/message', { text: 'hello' });
    assert.deepEqual([refused.status, await refused.text()], [409, "Mira doesn't know its inbox."]);
    assert.equal((await post('/api/sessions/s-msg/message', { text: '   ' })).status, 400);
    assert.equal((await post('/api/sessions/nobody/message', { text: 'hello' })).status, 404);
    assert.equal((await post('/api/sessions/s-msg/message', { text: 'hello' }, { Origin: 'https://evil.example' })).status, 403);
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

  it('starts a new session in the repo I pick, in a group of repos', async () => {
    const group = new Roster();
    const placeFor = (cwd: string | undefined) => ({ system: 'Site', repo: cwd?.split('\\').pop(), root: cwd });
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString(); // recent, so neither has gone quiet
    group.seed('claude-code', [
      { sessionId: 'g-1', system: 'Site', cwd: 'C:\\code\\site-app', lastAt: ago(2), status: 'my-turn', transcript: 'C:\\t\\g-1.jsonl' },
      { sessionId: 'g-2', system: 'Site', cwd: 'C:\\code\\site-docs', lastAt: ago(1), status: 'working', transcript: 'C:\\t\\g-2.jsonl' },
    ]);
    const site = createHub({ ...options, store: new Store(':memory:'), roster: group, placeFor });
    const at = await listen(site);
    try {
      const listed = ((await (await fetch(`${at}/api/sessions`)).json()) as { sessions: Array<{ id: string; repo?: string; name?: string }> }).sessions;
      assert.deepEqual(listed.map((s) => [s.id, s.repo]).sort(), [['g-1', 'site-app'], ['g-2', 'site-docs']]);
      assert.equal(new Set(listed.map((s) => s.name).filter(Boolean)).size, 2); // each mirling has a name of its own (decision 48)
      const target = await (await fetch(`${at}/api/systems/Site/start`)).json();
      assert.equal(target.folder, 'C:\\code\\site-docs'); // the one used last
      assert.deepEqual(target.choices.map((c: { folder: string }) => c.folder), ['C:\\code\\site-docs', 'C:\\code\\site-app']);
      const start = (body: unknown) => fetch(`${at}/api/systems/Site/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: at }, body: JSON.stringify(body) });
      assert.equal((await start({ prompt: 'Bump the app', folder: 'C:\\code\\site-app' })).status, 204);
      assert.equal((await start({ folder: 'C:\\Windows' })).status, 400);
    } finally {
      await new Promise((done) => site.server.close(done));
    }
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
    assert.match(page, /<link rel="icon" href="\/favicon\.svg"/);
    const icon = await fetch(`${base}/favicon.svg`);
    assert.deepEqual([icon.status, icon.headers.get('content-type')], [200, 'image/svg+xml']);
    assert.match(await icon.text(), /^<svg [^>]*viewBox="0 0 18 18"/); // a mirling
    const picture = await fetch(`${base}/mirling.png`); // on notifications
    assert.deepEqual([picture.status, picture.headers.get('content-type')], [200, 'image/png']);
    assert.match(page, /id="notify"/);
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

  it('keeps how I arranged a section and the island around it, for every browser', async () => {
    const put = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const layouts = async () => ((await (await fetch(`${base}/api/layouts`)).json()) as { layouts: unknown }).layouts;
    const layout = { placed: { '1,1': 'bench', '9,1': 'rock', '-3,12': 'boat', '2,1': 'trampoline' }, ground: { '0,4': 'f', '2,2': 'w' }, removed: ['8,4'], moved: { 0: [3, 4] }, styles: { 0: 'stone' } };
    assert.equal((await put('/api/layouts/mira', layout)).status, 204);
    assert.deepEqual(await layouts(), { mira: layout });
    assert.equal((await put('/api/layouts/mira', { placed: { '-4,1': 'bench' } })).status, 400); // beyond its reach
    assert.equal((await put('/api/layouts/mira', { moved: { 0: [9, 4] } })).status, 400); // a building on the shore
    assert.equal((await put('/api/layouts/mira', { castle: true })).status, 400);
    assert.equal((await put('/api/layouts/mira', { placed: {} })).status, 204); // nothing left to keep
    assert.deepEqual(await layouts(), {});
  });

  it('keeps a session calling for me unread until I read it, and again when it calls again', async () => {
    const of = async () => (await sessions()).sessions.find((s) => s.id === 's-9') as { unread?: boolean } | undefined;
    const hook = (hook_event_name: string, extra = {}) => post('/ingest/claude-code', { hook_event_name, session_id: 's-9', cwd: 'C:\\code\\mira', ...extra });
    const later = () => new Promise((done) => setTimeout(done, 5));
    await hook('SessionStart');
    await hook('UserPromptSubmit');
    assert.equal((await of())?.unread, undefined);
    await later();
    await hook('Stop');
    assert.equal((await of())?.unread, true);
    assert.equal((await post('/api/sessions/s-9/read', {})).status, 204);
    assert.equal((await of())?.unread, undefined);
    // Kept by the store, so a restart remembers it.
    assert.ok(store.reads()['s-9']);

    await later();
    await hook('UserPromptSubmit');
    await later();
    await hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    assert.equal((await of())?.unread, true);
    assert.equal((await post('/api/sessions/s-9/read', {})).status, 204);
    assert.equal((await of())?.unread, undefined);
    assert.equal((await post('/api/sessions/nobody/read', {})).status, 404);
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
