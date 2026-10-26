// The hub's HTTP face. It listens on 127.0.0.1 only and refuses requests sent by a web page on
// another site (decision: no access token while local), so no page in the browser can inject
// events, answer a prompt or read a session's story. Live updates go to the browser as
// Server-Sent Events. Each source plugs in through its adapter (decision 22).

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONTRACT_VERSION, MiraEvent } from '../../contracts/src/index.ts';
import type { Editor } from './editor.ts';
import { Permissions, summarise, type Decision } from './permissions.ts';
import type { Roster } from './roster.ts';
import type { SourceAdapter } from './sources.ts';
import type { Store } from './store.ts';
import type { Place } from './systems.ts';
import { serveWeb, webFile } from './web.ts';

type Payload = Record<string, unknown>;

export interface HubOptions {
  store: Store;
  roster: Roster;
  sources: SourceAdapter[];
  placeFor: (cwd: string | undefined) => Place;
  permissionWaitMs: number;
  recordShape?: (source: string, payload: Payload, bytes: number) => void;
  onEvent?: (event: MiraEvent) => void;
  /** Opens sessions in an editor; without it the board offers no editor button. */
  editor?: Editor;
  editorDelayMs?: number;
}

interface Viewer {
  res: ServerResponse;
  visible: boolean;
}

const MAX_BODY = 16 * 1024 * 1024;
const STORY_TURNS = 30;
const EDITOR_DELAY_MS = 1500;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;
const SYSTEMS_DAYS = 14;

export function createHub(options: HubOptions) {
  const { store, roster } = options;
  const sources = new Map(options.sources.map((s) => [s.id, s]));
  // Permission prompts are Claude Code's own hook, answered in its own format.
  const claude = sources.get('claude-code');
  const viewers = new Map<string, Viewer>();
  const permissions = new Permissions({
    waitMs: options.permissionWaitMs,
    watching: () => [...viewers.values()].some((v) => v.visible),
    onChange: () => broadcast('pending', permissions.pending()),
  });

  function broadcast(type: string, data: unknown) {
    const message = sse(type, data);
    for (const viewer of viewers.values()) viewer.res.write(message);
  }

  const sessions = () => roster.snapshot().map((s) => ({ ...s, title: sources.get(s.source)?.title?.(s), worktree: options.placeFor(s.cwd).worktree }));

  function record(event: MiraEvent | null) {
    if (!event || !store.add(event)) return;
    roster.apply(event);
    options.onEvent?.(event);
    broadcast('event', event);
    broadcast('sessions', sessions());
    sources.get(event.source)?.followUp?.(event, record);
  }

  async function ingest(req: IncomingMessage, res: ServerResponse, source: SourceAdapter) {
    const body = await readBody(req);
    res.writeHead(204).end();
    const payload = parseObject(body);
    if (!body || !payload) return;
    options.recordShape?.(source.id, payload, body.length);
    record(source.ingest?.(payload, hookTime(req)) ?? null);
  }

  async function permission(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    const payload = parseObject(body);
    if (body && payload) options.recordShape?.('claude-code', payload, body.length);
    const asked = payload ? (claude?.ingest?.(payload, new Date()) ?? null) : null;
    record(asked);
    if (!payload || !asked) return void res.writeHead(204).end();

    const prompt = { id: randomUUID(), sessionId: asked.actor.id, system: asked.system, tool: asked.detail?.tool, summary: summarise(asked.detail?.tool, payload.tool_input), askedAt: asked.at };
    res.on('close', () => permissions.cancel(prompt.id));
    const decision = await permissions.ask(prompt);
    if (res.writableEnded || res.destroyed) return;
    if (!decision) return void res.writeHead(204).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hookDecision(decision)));
    record(MiraEvent.parse({
      v: CONTRACT_VERSION,
      id: randomUUID(),
      at: new Date().toISOString(),
      source: 'claude-code',
      system: asked.system,
      actor: asked.actor,
      type: 'permission.answered',
      status: 'working',
      detail: { ...(asked.detail?.tool ? { tool: asked.detail.tool } : {}), decision, answeredBy: 'mira' },
      ...(asked.ref ? { ref: asked.ref } : {}),
    }));
  }

  function stream(req: IncomingMessage, res: ServerResponse, url: URL) {
    const id = randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(sse('hello', { viewer: id, waitSeconds: options.permissionWaitMs / 1000 }) + sse('sessions', sessions()) + sse('pending', permissions.pending()));
    viewers.set(id, { res, visible: url.searchParams.get('visible') !== '0' });
    req.on('close', () => viewers.delete(id));
  }

  async function presence(req: IncomingMessage, res: ServerResponse) {
    const body = parseObject(await readBody(req));
    const viewer = typeof body?.viewer === 'string' ? viewers.get(body.viewer) : undefined;
    if (!viewer || typeof body?.visible !== 'boolean') return reply(res, 400, 'Expected { viewer, visible }.');
    viewer.visible = body.visible;
    res.writeHead(204).end();
  }

  async function answer(req: IncomingMessage, res: ServerResponse, id: string) {
    const body = parseObject(await readBody(req));
    const decision = body?.decision;
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'terminal') return reply(res, 400, 'Expected { decision: "allow" | "deny" | "terminal" }.');
    const waiting = permissions.pending().some((p) => p.id === id);
    if (!waiting) return reply(res, 404, 'That prompt is no longer waiting.');
    // "terminal" hands the prompt back at once, so the normal terminal prompt appears.
    if (decision === 'terminal') permissions.cancel(id);
    else permissions.answer(id, decision);
    res.writeHead(204).end();
  }

  function story(res: ServerResponse, id: string, url: URL) {
    const session = roster.get(id);
    const source = session ? sources.get(session.source) : undefined;
    if (!session || !source?.story) return reply(res, 404, 'No story for that session.');
    const helper = url.searchParams.get('helper') ?? undefined;
    const turns = clamp(Number(url.searchParams.get('turns') ?? STORY_TURNS), 1, 1000);
    const told = source.story(session, { helper, turns });
    if (!told) return reply(res, 404, "That session's transcript can't be read.");
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(told));
  }

  // GET says which editor window holds the session, for the board's link; POST then opens the
  // session there, after the board's link has had a moment to bring that window forward.
  function editor(req: IncomingMessage, res: ServerResponse, id: string) {
    const session = roster.get(id);
    const at = session ? sources.get(session.source)?.continueAt?.(session) : undefined;
    const target = at ? options.editor?.target(at.folder) : undefined;
    if (!at || !target) return reply(res, 404, "That session can't be opened in an editor.");
    if (req.method === 'GET') return json(res, target);
    setTimeout(() => options.editor?.open(at.link), options.editorDelayMs ?? EDITOR_DELAY_MS).unref();
    res.writeHead(204).end();
  }

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (!fromThisMachine(req, port)) return reply(res, 403, 'Mira only accepts requests from this machine.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;
    const prompt = url.pathname.match(/^\/api\/prompts\/([\w-]+)$/);
    const ingestFor = req.method === 'POST' ? sources.get(url.pathname.match(/^\/ingest\/([a-z0-9-]+)$/)?.[1] ?? '') : undefined;
    const storyOf = req.method === 'GET' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/story$/)?.[1] : undefined;
    const editorOf = req.method === 'GET' || req.method === 'POST' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/editor$/)?.[1] : undefined;
    if (ingestFor?.ingest) return void ingest(req, res, ingestFor);
    if (route === 'POST /hooks/permission') return void permission(req, res);
    if (route === 'GET /api/sessions') return json(res, { sessions: sessions(), pending: permissions.pending(), waitSeconds: options.permissionWaitMs / 1000 });
    if (route === 'GET /api/events') return json(res, store.recent(clamp(Number(url.searchParams.get('limit') ?? 100), 1, 500)));
    if (storyOf) return story(res, storyOf, url);
    if (editorOf) return editor(req, res, editorOf);
    if (route === 'GET /api/stream') return stream(req, res, url);
    if (route === 'POST /api/presence') return void presence(req, res);
    if (req.method === 'POST' && prompt?.[1]) return void answer(req, res, prompt[1]);
    if (route === 'GET /api/systems') return json(res, { systems: store.systems(new Date(Date.now() - SYSTEMS_DAYS * 86_400_000).toISOString()).filter((s) => s.name !== 'unknown') });
    const served = req.method === 'GET' ? webFile(url.pathname) : undefined;
    if (served) return void serveWeb(res, served);
    reply(res, 404, 'Not found.');
  });

  const heartbeat = setInterval(() => {
    for (const viewer of viewers.values()) viewer.res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function close() {
    clearInterval(heartbeat);
    for (const viewer of viewers.values()) viewer.res.end();
    viewers.clear();
    server.closeAllConnections();
    server.close();
  }

  return { server, permissions, close };
}

// Hooks and curl send no Origin header; browsers do on cross-site requests, and mark every request
// with Sec-Fetch-Site. Checking Host as well stops DNS rebinding, where a site points its own name
// at 127.0.0.1.
function fromThisMachine(req: IncomingMessage, port: number): boolean {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!local.includes(req.headers.host ?? '')) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  return origin === undefined || local.some((host) => origin === `http://${host}`);
}

/** When the hook fired, sent by the background command; falls back to arrival time. */
function hookTime(req: IncomingMessage): Date {
  const ms = Number(req.headers['x-mira-at']);
  return Number.isFinite(ms) && Math.abs(ms - Date.now()) < CLOCK_SKEW_MS ? new Date(ms) : new Date();
}

function hookDecision(decision: Decision) {
  const verdict = decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Mira.' };
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } };
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(size <= MAX_BODY ? Buffer.concat(chunks) : null));
    req.on('error', () => resolve(null));
  });
}

function parseObject(body: Buffer | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : max);

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}
