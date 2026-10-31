// The hub's HTTP face. It listens on 127.0.0.1 only and refuses requests sent by a web page on
// another site (decision: no access token while local), so no page in the browser can inject
// events, answer a prompt or read a session's story. Live updates go to the browser as
// Server-Sent Events. Each source plugs in through its adapter (decision 22).

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { CONTRACT_VERSION, MiraEvent } from '../../contracts/src/index.ts';
import type { Trips } from '../web/shared/acts.ts';
import { CLASH_MS, findClashes, type Clash } from './clashes.ts';
import type { Editor, EditorTarget } from './editor.ts';
import { usageMeter, type FootprintReport } from './footprint.ts';
import { unlocksFrom } from './unlocks.ts';
import type { Growth } from './growth.ts';
import { MirlingNames, type Pack } from './mirlings.ts';
import { Permissions, summarise, type Decision } from './permissions.ts';
import type { Roster, SessionView } from './roster.ts';
import type { SourceAdapter } from './sources.ts';
import type { Kind, Store } from './store.ts';
import type { Place } from './systems.ts';
import type { Terminals } from './terminals.ts';
import type { UpdateStatus } from './update-status.ts';
import type { Updates } from './updates.ts';
import { emptyLayout, SectionLayout } from './layout.ts';
import { serveWeb, webFile } from './web.ts';

type Payload = Record<string, unknown>;

export interface HubOptions {
  store: Store;
  roster: Roster;
  sources: SourceAdapter[];
  placeFor: (cwd: string | undefined) => Place;
  /** Which names mirlings get (decision 48); cute ones unless the config says otherwise. */
  mirlingNames?: Pack;
  permissionWaitMs: number;
  recordShape?: (source: string, payload: Payload, bytes: number) => void;
  onEvent?: (event: MiraEvent) => void;
  /** Opens sessions in an editor; without it the board offers no editor button. */
  editor?: Editor;
  editorDelayMs?: number;
  /** Each project's recent commits, which grow its buildings (decision 35). */
  growth?: { get(system: string): Growth | undefined };
  /** The way to the terminal host (decision 38); without it no session offers a terminal. */
  terminals?: Terminals;
  /** Mira's own updates (decision 60); without it the page says it can't tell. */
  updates?: Pick<Updates, 'status' | 'check' | 'apply'>;
}

interface Viewer {
  res: ServerResponse;
  visible: boolean;
}

const MAX_BODY = 16 * 1024 * 1024;
const STORY_TURNS = 30;
const EDITOR_DELAY_MS = 1500;
// Links go through the operating system, which may cut long ones short.
const MAX_PROMPT = 1500;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25 * 1000;
const CHANGES_MS = 5 * 1000;
const SYSTEMS_DAYS = 14;
// The paths mirlings wear come from the last 30 days of trips, counted again at most every ten minutes (decision 67).
const TRIP_DAYS = 30;
const TRIPS_MS = 10 * 60 * 1000;
const HISTORY_PAGE = 20;
const MAX_MESSAGE = 20_000;
// A session sits at its prompt in these, so a reply can be typed into its terminal (decision 57).
const AT_PROMPT = new Set(['my-turn', 'failed', 'waiting']);

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

  // My own names, and what I removed from view (decision 30), kept in memory and written through.
  const names: Record<Kind, Record<string, string>> = { system: store.names('system'), session: store.names('session') };
  const removed: Record<Kind, Record<string, string>> = { system: store.removed('system'), session: store.removed('session') };
  // Removed stays removed until something happens after it.
  const gone = (kind: Kind, key: string, lastAt: string) => (removed[kind][key] ?? '') >= lastAt;
  // Where in its project a session runs: its worktree, and its repo when the project is a group (decision 47).
  const labels = (cwd: string | undefined) => {
    const { worktree, repo } = options.placeFor(cwd);
    return { worktree, ...(repo ? { repo } : {}) };
  };

  const mirlings = new MirlingNames(store, options.mirlingNames);

  // When I last read each session (decision 55), written through like names.
  const reads = store.reads();
  // It called for me since I last read it, and what it called for still stands.
  const unread = (s: SessionView) => Boolean(s.calledAt && (s.status === 'needs-me' || s.status === 'my-turn' || s.status === 'failed') && s.calledAt > (reads[s.id] ?? ''));

  // Live sessions on the board that edited the same file in the last hour (decision 58), each file
  // shown from its session's own repo.
  function clashesAmong(shown: SessionView[]): Map<string, Clash[]> {
    const live = new Set(shown.filter((s) => s.status && s.status !== 'ended').map((s) => s.id));
    const edits = options.sources.flatMap((source) => source.edits?.(Date.now() - CLASH_MS) ?? []);
    const found = findClashes(edits, live);
    for (const [id, clashes] of found) {
      const root = options.placeFor(shown.find((s) => s.id === id)?.cwd).root;
      found.set(id, clashes.slice(0, 10).map((c) => ({ ...c, file: fromRoot(root, c.file) })));
    }
    return found;
  }

  const sessions = () => {
    const all = roster.snapshot();
    const named = mirlings.names(all.map((s) => s.id));
    const shown = all.filter((s) => !gone('session', s.id, s.lastAt) && !gone('system', s.system, s.lastAt));
    const clashing = clashesAmong(shown);
    return shown.map((s) => ({
      ...s,
      name: named.get(s.id),
      title: names.session[s.id] ?? sources.get(s.source)?.title?.(s),
      ...labels(s.cwd),
      ...(sources.get(s.source)?.canMessage?.(s) ? { canMessage: true } : {}),
      ...(unread(s) ? { unread: true } : {}),
      ...(clashing.has(s.id) ? { clashes: clashing.get(s.id) } : {}),
    }));
  };

  // A session on the board, or an earlier one a source still keeps (decision 40), which then joins
  // the roster so its story, terminal and editor work like any other's.
  function sessionById(id: string): SessionView | undefined {
    const known = roster.get(id);
    if (known) return known;
    for (const source of options.sources) {
      const past = source.history?.().find((p) => p.sessionId === id);
      if (!past) continue;
      roster.seed(source.id, [past]);
      return roster.get(id);
    }
    return undefined;
  }

  // A project's earlier conversations, newest first, leaving out those on the board. Titles and
  // folders are read from the sources when asked, and never stored.
  function history(res: ServerResponse, system: string, url: URL) {
    const limit = clamp(Number(url.searchParams.get('limit') ?? HISTORY_PAGE), 1, 100);
    const before = url.searchParams.get('before') ?? '\uffff';
    const shown = new Set(sessions().map((s) => s.id));
    const past = options.sources
      .flatMap((source) => (source.history?.() ?? []).map((p) => ({ ...p, source: source.id })))
      .filter((p) => p.system === system && p.lastAt < before && !shown.has(p.sessionId))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    const spent = store.spent(system);
    const page = past.slice(0, limit).map((p) => ({
      id: p.sessionId, source: p.source, system, cwd: p.cwd, lastAt: p.lastAt,
      title: names.session[p.sessionId] ?? p.title, ...labels(p.cwd),
      ...(spent[p.sessionId] ? { usage: spent[p.sessionId] } : {}),
    }));
    json(res, { sessions: page, more: past.length > limit });
  }

  let trips: Record<string, Trips> = {};
  let tripsAt = -Infinity;
  const tripsNow = () => {
    if (Date.now() - tripsAt > TRIPS_MS) {
      trips = store.trips(new Date(Date.now() - TRIP_DAYS * 86_400_000).toISOString());
      tripsAt = Date.now();
    }
    return trips;
  };

  const systems = () => store.systems(new Date(Date.now() - SYSTEMS_DAYS * 86_400_000).toISOString())
    .filter((s) => s.name !== 'unknown' && !gone('system', s.name, s.lastAt))
    .map((s) => {
      const growth = options.growth?.get(s.name);
      const worn = tripsNow()[s.name];
      return { ...s, ...(names.system[s.name] ? { label: names.system[s.name] } : {}), ...(growth ? { growth } : {}), ...(worn ? { trips: worn } : {}) };
    });

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
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    record(source.ingest?.(payload, hookTime(req), headers) ?? null);
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
    res.write(sse('hello', { viewer: id, waitSeconds: options.permissionWaitMs / 1000 }) + sse('layouts', layouts) + sse('systems', systems()) + sse('sessions', sessions()) + sse('pending', permissions.pending()) + sse('update', updateStatus()));
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
    const session = sessionById(id);
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
    const session = sessionById(id);
    const at = session ? sources.get(session.source)?.continueAt?.(session) : undefined;
    const target = at ? options.editor?.target(at.folder) : undefined;
    if (!at || !target) return reply(res, 404, "That session can't be opened in an editor.");
    if (req.method === 'GET') return json(res, target);
    setTimeout(() => options.editor?.open(at.link), options.editorDelayMs ?? EDITOR_DELAY_MS).unref();
    res.writeHead(204).end();
  }

  // POST { text } sends a running session my message, wherever it runs (decision 46), and says how:
  // `{ via: 'terminal' }` when it was typed into Mira's own terminal, where the session sits at its
  // prompt, just as I'd type it there (decision 57), or `{ via: 'inbox' }`. Never into a terminal
  // that's busy or asking something, where Enter could answer it. It answers once the session has it;
  // the reply arrives as the session's events and story.
  async function message(req: IncomingMessage, res: ServerResponse, id: string) {
    const session = sessionById(id);
    const source = session ? sources.get(session.source) : undefined;
    if (!session || !source?.message) return reply(res, 404, "Mira can't send that session a message.");
    const body = parseObject(await readBody(req));
    const text = typeof body?.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) return reply(res, 400, 'Expected { text }.');
    if (text.length > MAX_MESSAGE) return reply(res, 400, `A message is up to ${MAX_MESSAGE} characters.`);
    const typed = AT_PROMPT.has(session.status ?? '') && terminals && terminalSpec(id) && (await terminals.running(id)) && (await terminals.type(id, text));
    if (!typed) {
      const failed = await source.message(session, text);
      if (failed) return reply(res, 409, failed);
    }
    json(res, { via: typed ? 'terminal' : 'inbox' });
    broadcast('sessions', sessions());
  }

  // POST { sessions: [one, other] } tells two sessions editing the same file about each other
  // (decision 58), through their inboxes, as a heads-up from Mira rather than a prompt of mine.
  async function tell(req: IncomingMessage, res: ServerResponse) {
    const body = parseObject(await readBody(req));
    const ids = Array.isArray(body?.sessions) ? body.sessions : [];
    if (ids.length !== 2 || ids.some((id) => typeof id !== 'string') || ids[0] === ids[1]) return reply(res, 400, 'Expected { sessions: [one, other] }.');
    const listed = sessions();
    const pair = ids.map((id) => listed.find((s) => s.id === id));
    const [one, other] = pair;
    if (!one || !other || !one.clashes?.some((c) => c.with === other.id)) return reply(res, 409, "Those two sessions aren't editing the same file any more.");
    const failed: string[] = [];
    for (const [to, about] of [[one, other], [other, one]] as const) {
      const files = [...new Set((to.clashes ?? []).filter((c) => c.with === about.id).map((c) => c.file))];
      const source = sources.get(to.source);
      const session = roster.get(to.id);
      const why = source?.message && session ? await source.message(session, headsUp(about, files)) : "Mira can't message it.";
      if (why) failed.push(`${to.name ?? to.title ?? to.id}: ${why}`);
    }
    if (failed.length === 2) return reply(res, 409, failed.join(' '));
    json(res, { told: 2 - failed.length, ...(failed.length ? { failed: failed.join(' ') } : {}) });
  }

  // POST .../read says I've read what a session called me for, so it stops calling until it calls
  // again (decision 55).
  function read(res: ServerResponse, id: string) {
    if (!roster.get(id)) return reply(res, 404, 'Mira has no session by that id.');
    reads[id] = new Date().toISOString();
    store.setRead(id, reads[id]);
    res.writeHead(204).end();
    broadcast('sessions', sessions());
  }

  // A project's own folders: the roots of its live sessions, most recent first, then of the folders
  // its stored events name, as long as they still exist and the editor can find a window for them.
  // A project has one, unless it's a group of repos (decision 47).
  function projectFolders(system: string): Array<{ folder: string; target: EditorTarget }> {
    const live = roster.snapshot().filter((s) => s.system === system && s.cwd).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).map((s) => s.cwd as string);
    const found = new Map<string, EditorTarget>();
    for (const cwd of new Set([...live, ...store.folders(system, 100)])) {
      const place = options.placeFor(cwd);
      if (place.system !== system || !place.root || found.has(place.root)) continue;
      const target = options.editor?.target(place.root);
      if (target) found.set(place.root, target);
    }
    return [...found].map(([folder, target]) => ({ folder, target }));
  }

  // Starting a new session works like carrying one on: GET names the window, for the page's link,
  // and POST then opens a new chat there with my prompt typed in, never sent (decision 29). In a
  // group, GET also lists its repos to choose from, and POST names the one chosen.
  async function startIn(req: IncomingMessage, res: ServerResponse, system: string) {
    const starter = options.sources.find((s) => s.startAt);
    const folders = starter ? projectFolders(system) : [];
    if (!starter || !folders[0]) return reply(res, 404, `Mira doesn't know a folder for ${system} yet.`);
    const choice = (f: { folder: string; target: EditorTarget }) => ({ ...f.target, folder: f.folder });
    if (req.method === 'GET') return json(res, { ...choice(folders[0]), ...(folders.length > 1 ? { choices: folders.map(choice) } : {}) });
    const body = parseObject(await readBody(req)) ?? {};
    const found = body.folder === undefined ? folders[0] : folders.find((f) => f.folder === body.folder);
    if (!found) return reply(res, 400, `That folder isn't one of ${system}'s.`);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length > MAX_PROMPT) return reply(res, 400, `A prompt opened from Mira can be up to ${MAX_PROMPT} characters.`);
    const at = starter.startAt?.(found.folder, prompt || undefined);
    if (!at) return reply(res, 404, `Mira can't start a session in ${system}.`);
    setTimeout(() => options.editor?.open(at.link), options.editorDelayMs ?? EDITOR_DELAY_MS).unref();
    res.writeHead(204).end();
  }

  // PUT /api/names/<kind>/<key> { name } renames; POST /api/remove/<kind>/<key> removes from view.
  async function change(req: IncomingMessage, res: ServerResponse, action: 'names' | 'remove', kind: Kind, key: string) {
    if (action === 'names') {
      if (req.method !== 'PUT') return reply(res, 405, 'Rename with PUT.');
      const body = parseObject(await readBody(req));
      const name = typeof body?.name === 'string' ? body.name.trim() : null;
      if (name === null || name.length > 80) return reply(res, 400, 'Expected { name }, up to 80 characters; an empty name goes back to the original.');
      const session = kind === 'session' ? sessionById(key) : undefined;
      const source = session && sources.get(session.source);
      if (session && source?.rename) {
        // The source keeps this session's name, and Mira keeps none of its own (decision 37).
        if (!name) return reply(res, 400, 'Give the session a name. Claude Code keeps it, and has no way back to the one it made up.');
        try {
          if (!source.rename(session, name)) return reply(res, 409, "Mira can't rename this session.");
        } catch (error) {
          return reply(res, 500, `Couldn't save the name: ${(error as Error).message}`);
        }
        store.setName(kind, key, '');
        delete names[kind][key];
      } else {
        store.setName(kind, key, name);
        if (name) names[kind][key] = name;
        else delete names[kind][key];
      }
    } else {
      if (req.method !== 'POST') return reply(res, 405, 'Remove with POST.');
      const at = new Date().toISOString();
      store.remove(kind, key, at);
      removed[kind][key] = at;
    }
    res.writeHead(204).end();
    broadcast('systems', systems());
    broadcast('sessions', sessions());
  }

  // Build mode (decision 39): how I arranged each project's section, the same in every browser.
  const layouts = store.layouts();
  async function arrange(req: IncomingMessage, res: ServerResponse, system: string) {
    const parsed = SectionLayout.safeParse(parseObject(await readBody(req)));
    if (!parsed.success) return reply(res, 400, 'Expected a section layout: ground, placed, removed, moved and styles, on its own ground.');
    const layout = emptyLayout(parsed.data) ? null : parsed.data;
    store.setLayout(system, layout);
    if (layout) layouts[system] = layout;
    else delete layouts[system];
    res.writeHead(204).end();
    broadcast('layouts', layouts);
  }

  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (!fromThisMachine(req, port)) return reply(res, 403, 'Mira only accepts requests from this machine.');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;
    const prompt = url.pathname.match(/^\/api\/prompts\/([\w-]+)$/);
    const ingestFor = req.method === 'POST' ? sources.get(url.pathname.match(/^\/ingest\/([a-z0-9-]+)$/)?.[1] ?? '') : undefined;
    const storyOf = req.method === 'GET' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/story$/)?.[1] : undefined;
    const terminalOf = req.method === 'GET' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/terminal$/)?.[1] : undefined;
    const editorOf = req.method === 'GET' || req.method === 'POST' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/editor$/)?.[1] : undefined;
    const messageTo = req.method === 'POST' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/message$/)?.[1] : undefined;
    const readOf = req.method === 'POST' ? url.pathname.match(/^\/api\/sessions\/([\w-]+)\/read$/)?.[1] : undefined;
    const manage = req.method === 'PUT' || req.method === 'POST' ? url.pathname.match(/^\/api\/(names|remove)\/(system|session)\/([^/]{1,240})$/) : null;
    const startOf = req.method === 'GET' || req.method === 'POST' ? url.pathname.match(/^\/api\/systems\/([^/]{1,240})\/start$/)?.[1] : undefined;
    const historyOf = req.method === 'GET' ? url.pathname.match(/^\/api\/systems\/([^/]{1,240})\/history$/)?.[1] : undefined;
    const layoutOf = req.method === 'PUT' ? url.pathname.match(/^\/api\/layouts\/([^/]{1,240})$/)?.[1] : undefined;
    if (ingestFor?.ingest) return void ingest(req, res, ingestFor);
    if (route === 'POST /hooks/permission') return void permission(req, res);
    if (route === 'GET /api/sessions') return json(res, { sessions: sessions(), pending: permissions.pending(), waitSeconds: options.permissionWaitMs / 1000 });
    if (route === 'GET /api/events') return json(res, store.recent(clamp(Number(url.searchParams.get('limit') ?? 100), 1, 500)));
    if (storyOf) return story(res, storyOf, url);
    if (terminalOf) return void terminal(res, terminalOf);
    if (editorOf) return editor(req, res, editorOf);
    if (messageTo) return void message(req, res, messageTo);
    if (route === 'POST /api/clashes/tell') return void tell(req, res);
    if (readOf) return read(res, readOf);
    if (route === 'GET /api/update') return json(res, updateStatus());
    if (route === 'POST /api/update/check') return void checkForUpdate(res);
    if (route === 'POST /api/update') return void update(req, res);
    if (route === 'GET /api/footprint') return void footprint(res);
    if (route === 'GET /api/unlocks') return json(res, { unlocks: unlocksFrom(store.turnTally(), new Date()) });
    if (startOf) return void startIn(req, res, decodeName(startOf));
    if (historyOf) return history(res, decodeName(historyOf), url);
    if (route === 'GET /api/stream') return stream(req, res, url);
    if (route === 'POST /api/presence') return void presence(req, res);
    if (req.method === 'POST' && prompt?.[1]) return void answer(req, res, prompt[1]);
    if (route === 'GET /api/systems') return json(res, { systems: systems() });
    if (route === 'GET /api/layouts') return json(res, { layouts });
    if (layoutOf) return void arrange(req, res, decodeName(layoutOf));
    if (manage) return void change(req, res, manage[1] as 'names' | 'remove', manage[2] as Kind, decodeName(manage[3] as string));
    const served = req.method === 'GET' ? webFile(url.pathname) : undefined;
    if (served) return void serveWeb(res, served);
    reply(res, 404, 'Not found.');
  });

  // Every few seconds, notice changes no event announces: ended sessions leaving once their few
  // minutes are up, or a session renamed in VS Code. The heartbeat keeps quiet connections open.
  let shown = '';
  const watch = setInterval(() => {
    if (!viewers.size) return void (shown = '');
    const now = JSON.stringify(sessions());
    if (shown && now !== shown) broadcast('sessions', JSON.parse(now));
    shown = now;
  }, CHANGES_MS);
  watch.unref();
  const heartbeat = setInterval(() => {
    for (const viewer of viewers.values()) viewer.res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // Terminals (decisions 36 and 38): GET /api/sessions/<id>/terminal says whether a session can have
  // one and whether it's running; the WebSocket at the same address carries it, relayed to the
  // terminal host, with the same checks as every other request, so no other site can reach it.
  const terminals = options.terminals;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const terminalSpec = (id: string) => {
    const session = sessionById(id);
    return session && terminals ? (sources.get(session.source)?.terminalFor?.(session) ?? null) : null;
  };
  async function terminal(res: ServerResponse, id: string) {
    const available = Boolean(terminalSpec(id));
    json(res, { available, running: available && terminals ? await terminals.running(id) : false });
  }
  server.on('upgrade', (req, socket, head) => {
    const port = (server.address() as AddressInfo).port;
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const id = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/terminal$/)?.[1];
    if (!id || !fromThisMachine(req, port) || !terminalSpec(id)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const size = { cols: clamp(Number(url.searchParams.get('cols') ?? 100), 10, 500), rows: clamp(Number(url.searchParams.get('rows') ?? 30), 5, 200) };
    sockets.handleUpgrade(req, socket, head, (ws) => terminals?.attach(id, ws, terminalSpec(id), size));
  });

  function close() {
    clearInterval(heartbeat);
    clearInterval(watch);
    terminals?.closeAll();
    for (const page of sockets.clients) page.close(1012, 'The hub is restarting.');
    sockets.close();
    for (const viewer of viewers.values()) viewer.res.end();
    viewers.clear();
    server.closeAllConnections();
    server.close();
  }

  /** Sends every page the project list again, for when something outside an event changes it, such as commit counts. */
  const announceSystems = () => broadcast('systems', systems());

  // Mira's own updates (decision 60): GET says where the copy stands, POST /check fetches and looks
  // again, and POST takes the update, after which the hub closes and the updater starts it again.
  // The app gives its own process, to be opened again once the update is in.
  const updates = options.updates;
  const updateStatus = (): UpdateStatus => updates?.status() ?? { state: 'unknown', reason: "This hub doesn't update itself." };
  async function checkForUpdate(res: ServerResponse) {
    if (!updates) return reply(res, 404, "This hub doesn't update itself.");
    json(res, await updates.check());
  }
  async function update(req: IncomingMessage, res: ServerResponse) {
    if (!updates) return reply(res, 404, "This hub doesn't update itself.");
    const app = parseObject(await readBody(req))?.app;
    if (app !== undefined && !(Number.isInteger(app) && (app as number) > 0)) return reply(res, 400, 'Expected { app }, the app\'s process, or nothing.');
    const failed = await updates.apply(app as number | undefined);
    if (failed) return reply(res, 409, failed);
    res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify(updates.status()));
  }
  /** Sends every page where the update stands, for when a check finishes or an update starts. */
  const announceUpdate = () => broadcast('update', updateStatus());

  // What the hub and the terminal host cost the machine, for Settings while it's open (decision 61).
  const hubUsage = usageMeter();
  async function footprint(res: ServerResponse) {
    const report: FootprintReport = { hub: hubUsage(), terminals: (await terminals?.usage()) ?? null };
    json(res, report);
  }

  return { server, permissions, close, announceSystems, announceUpdate };
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

/** A file as its repo names it, such as `hub/src/server.ts`, or its whole path outside the repo. */
function fromRoot(root: string | undefined, file: string): string {
  const inside = root ? relative(root, file) : '';
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : file;
}

/** What Mira tells a session editing the same files as another (decision 58). */
function headsUp(other: { name?: string; title?: string }, files: string[]): string {
  const who = [other.name, other.title ? `“${other.title}”` : ''].filter(Boolean).join(', ');
  const what = files.length > 1 ? `${files.slice(0, -1).join(', ')} and ${files.at(-1)}` : (files[0] ?? 'the same files');
  const them = files.length > 1 ? 'them' : 'it';
  return `A heads-up from Mira: another Claude Code session on this machine${who ? ` (${who})` : ''} has also edited ${what} in the last hour. Re-read ${them} before you change ${them} again, and take care not to undo that session's work.`;
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

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function json(res: ServerResponse, data: unknown) {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
}

function reply(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}
