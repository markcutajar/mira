// The hub's HTTP face. It listens on 127.0.0.1 only and refuses requests sent by a web page on
// another site (decision: no access token while local), so no page in the browser can inject
// events or answer a prompt. Live updates go to the browser as Server-Sent Events.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONTRACT_VERSION, MiraEvent } from '../../contracts/src/index.ts';
import { normalise, type HookPayload } from './claude-code/normalise.ts';
import type { Colony } from './colony.ts';
import { Permissions, summarise, type Decision } from './permissions.ts';
import type { Store } from './store.ts';

export interface HubOptions {
  store: Store;
  colony: Colony;
  systemFor: (cwd: string | undefined) => string;
  permissionWaitMs: number;
  recordShape?: (source: string, payload: HookPayload, bytes: number) => void;
  onEvent?: (event: MiraEvent) => void;
}

interface Viewer {
  res: ServerResponse;
  visible: boolean;
}

const MAX_BODY = 16 * 1024 * 1024;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;

export function createHub(options: HubOptions) {
  const { store, colony } = options;
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

  function record(event: MiraEvent | null) {
    if (!event || !store.add(event)) return;
    colony.apply(event);
    options.onEvent?.(event);
    broadcast('event', event);
    broadcast('sessions', colony.snapshot());
  }

  function eventFrom(payload: HookPayload, at: Date): MiraEvent | null {
    const cwd = typeof payload.new_cwd === 'string' ? payload.new_cwd : typeof payload.cwd === 'string' ? payload.cwd : undefined;
    return normalise(payload, { at: at.toISOString(), system: options.systemFor(cwd) });
  }

  async function ingest(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    res.writeHead(204).end();
    const payload = parseObject(body);
    if (!body || !payload) return;
    options.recordShape?.('claude-code', payload, body.length);
    record(eventFrom(payload, hookTime(req)));
  }

  async function permission(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    const payload = parseObject(body);
    if (body && payload) options.recordShape?.('claude-code', payload, body.length);
    const asked = payload ? eventFrom(payload, new Date()) : null;
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
    res.write(sse('hello', { viewer: id }) + sse('sessions', colony.snapshot()) + sse('pending', permissions.pending()));
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
    if (decision !== 'allow' && decision !== 'deny') return reply(res, 400, 'Expected { decision: "allow" | "deny" }.');
    if (!permissions.answer(id, decision)) return reply(res, 404, 'That prompt is no longer waiting.');
    res.writeHead(204).end();
  }

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (!fromThisMachine(req, port)) return reply(res, 403, 'Mira only accepts requests from this machine.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;
    const prompt = url.pathname.match(/^\/api\/prompts\/([\w-]+)$/);
    if (route === 'POST /ingest/claude-code') return void ingest(req, res);
    if (route === 'POST /hooks/permission') return void permission(req, res);
    if (route === 'GET /api/sessions') return json(res, { sessions: colony.snapshot(), pending: permissions.pending() });
    if (route === 'GET /api/events') return json(res, store.recent(clamp(Number(url.searchParams.get('limit') ?? 100), 1, 500)));
    if (route === 'GET /api/stream') return stream(req, res, url);
    if (route === 'POST /api/presence') return void presence(req, res);
    if (req.method === 'POST' && prompt?.[1]) return void answer(req, res, prompt[1]);
    if (route === 'GET /') return home(res, colony.snapshot().length);
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

// Hooks and curl send no Origin header; browsers do on cross-site requests. Checking Host as well
// stops DNS rebinding, where a site points its own name at 127.0.0.1.
function fromThisMachine(req: IncomingMessage, port: number): boolean {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!local.includes(req.headers.host ?? '')) return false;
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

function home(res: ServerResponse, sessions: number) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>Mira hub</title><body style="font:15px system-ui;background:#0b0d1a;color:#ece8d9;padding:24px">` +
    `<h1 style="font-size:20px">Mira hub is running</h1><p>${sessions} session${sessions === 1 ? '' : 's'} in view. The status board arrives in step 3.</p>` +
    `<p>Live data: <a style="color:#ffd34d" href="/api/sessions">/api/sessions</a> · <a style="color:#ffd34d" href="/api/events">/api/events</a></p></body>`,
  );
}
