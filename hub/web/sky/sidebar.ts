// The board, condensed down the left of the sky (decision 31): what's waiting for me, then every
// project with its sessions and, folded away, its earlier conversations (decision 40). A session row
// flies to its mirling and opens its story. Projects stay in the order I put them in, by dragging one
// or from its ⋯ menu, and sessions in the order they started, so nothing moves on its own (decision 70).

import { ago, answerPrompt, cost, esc, folder, markRead, projectLabel, sessionLabel, short, statusLabel, toast, waited, when, type BoardSession, type PendingPrompt } from '../shared/format.ts';
import type { Live } from '../shared/live.ts';
import { doneWith, removeThing, renameThing } from '../shared/manage.ts';
import { openStart } from '../shared/start.ts';

export interface SidebarOptions {
  live: Live;
  /** The session whose story is open, to mark its row. */
  current(): string | null;
  /** A session row was clicked. */
  onSession(id: string): void;
  /** A project's name was clicked. */
  onProject(name: string): void;
  /** A session was ticked off the board with its ✓. */
  onDone(id: string): void;
}

// A session's read and done buttons (decision 55), an open envelope and a tick drawn in pixels like the island.
const pixels = (rows: string[]) => rows.flatMap((row, y) => [...row].map((p, x) => (p === '#' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : ''))).join('');
const icon = (wide: number, tall: number, body: string) => `<svg viewBox="0 0 ${wide} ${tall}" width="${wide * 1.2}" height="${tall * 1.2}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${body}</svg>`;
const OPENED = icon(11, 9, pixels(['.....#.....', '...##.##...', '.##.....##.', '#.........#', '##.......##', '#.##...##.#', '#...###...#', '#.........#', '###########']));
const TICK = icon(9, 7, pixels(['........#', '.......##', '#.....##.', '##...##..', '.##.##...', '..###....', '...#.....']));
// Two sessions editing the same file (decision 58): a bolt, like the one over their mirlings.
const BOLT = icon(5, 8, pixels(['..###', '.###.', '.##..', '#####', '..##.', '.##..', '.#...', '#....']));
const CALLING = new Set(['needs-me', 'my-turn', 'failed']);

export interface Sidebar {
  render(): void;
  /** Scrolls to a project and highlights it, for a click on its section in the sky. */
  showProject(name: string): void;
  /** An earlier conversation listed here, for the story of one that's no longer on the board. */
  past(id: string): BoardSession | undefined;
}

/** A project's earlier conversations, while its fold is open. */
interface Fold {
  sessions: BoardSession[];
  more: boolean;
  loading: boolean;
  error: string;
  /** The project's sessions on the board when the list was read, to read it again when one leaves. */
  live: string;
}

const EARLIER_PAGE = 20;


export function createSidebar(root: HTMLElement, options: SidebarOptions): Sidebar {
  const { live } = options;
  const menus = new Set<string>(); // projects whose ⋯ menu is open
  const busy = new Set<string>(); // prompts being answered
  const earlier = new Map<string, Fold>(); // projects whose earlier conversations are unfolded
  let last = '';
  // The project being dragged to a new place, during which the board isn't drawn again under it.
  let dragging: string | null = null;

  function render() {
    if (dragging) return;
    for (const [system, fold] of earlier) if (!fold.loading && fold.live !== liveIn(system)) void loadEarlier(system);
    const html = promptsHTML() + projectsHTML();
    if (html === last) return tick();
    root.innerHTML = html;
    last = html;
    tick();
  }

  function promptsHTML(): string {
    if (!live.pending.length) return '';
    return `<section class="side-prompts" aria-label="Waiting for you"><h2 class="eyebrow">Waiting for you</h2>${live.pending.map(promptHTML).join('')}</section>`;
  }

  function promptHTML(p: PendingPrompt): string {
    const session = live.sessions.find((s) => s.id === p.sessionId);
    const off = busy.has(p.id) ? ' disabled' : '';
    return `<article class="prompt box" data-prompt-id="${esc(p.id)}">
      <div class="prompt-head"><span class="where">${esc(projectLabel(p.system, live.systems))}</span><span class="countdown" data-asked="${esc(p.askedAt)}"></span></div>
      <p class="prompt-title"><button type="button" class="title-btn" data-session="${esc(p.sessionId)}">${esc(session ? sessionLabel(session) : short(p.sessionId))}</button> wants to use <b>${esc(p.tool || 'a tool')}</b></p>
      ${p.summary ? `<pre class="cmd">${esc(p.summary)}</pre>` : ''}
      <div class="actions">
        <button type="button" class="go small" data-answer="allow"${off}>Allow</button>
        <button type="button" class="stop small" data-answer="deny"${off}>Deny</button>
        <button type="button" class="ghost small" data-answer="terminal"${off}>In terminal</button>
      </div>
      <div class="bar"><i></i></div>
    </article>`;
  }

  // Projects in the order I put them in, then any I haven't placed, in the order they first appeared,
  // as on the island, so a new one joins at the bottom (decision 70).
  function ordered(): string[] {
    const names = [...new Set([...live.systems.map((s) => s.name), ...live.sessions.map((s) => s.system)])];
    const place = (name: string) => live.systems.find((s) => s.name === name)?.place ?? Infinity;
    return names.map((name, i) => ({ name, i })).sort((a, b) => place(a.name) - place(b.name) || a.i - b.i).map((p) => p.name);
  }

  // Each project's sessions in the order they started, newest at the bottom.
  function projectsHTML(): string {
    const names = ordered();
    if (!names.length) return '<p class="hint side-empty">No projects yet. Start a Claude Code session in any repo and it appears here, and on the island.</p>';
    return names.map((name) => projectHTML(name, live.sessions.filter((s) => s.system === name).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)))).join('');
  }

  /** Puts the projects in a new order, here at once and on the hub for every page. */
  function reorder(names: string[]) {
    for (const s of live.systems) {
      const place = names.indexOf(s.name);
      if (place >= 0) s.place = place;
    }
    render();
    void fetch('/api/board/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systems: names }) })
      .then(async (res) => { if (!res.ok) toast((await res.text()) || `The hub couldn't keep that order (${res.status}).`); })
      .catch(() => toast("The hub isn't reachable, so that order wasn't kept."));
  }

  /** Moves a project to sit before another, or to the bottom. */
  function moveProject(name: string, before: string | null) {
    const names = ordered().filter((n) => n !== name);
    const at = before === null ? names.length : names.indexOf(before);
    names.splice(at < 0 ? names.length : at, 0, name);
    reorder(names);
  }

  function projectHTML(system: string, sessions: BoardSession[]): string {
    const label = projectLabel(system, live.systems);
    const active = sessions.filter((s) => s.status && s.status !== 'ended').length;
    const needs = sessions.filter((s) => s.status === 'needs-me').length;
    const spent = sessions.reduce((sum, s) => sum + (s.usage?.costUsd ?? 0), 0);
    const commits = live.systems.find((s) => s.name === system)?.growth?.commits ?? 0;
    const made = commits ? `<span title="Commits in the last 30 days">${commits} commit${commits === 1 ? '' : 's'}</span>` : '';
    const meta = [sessions.length ? `${active} active` : 'quiet', spent ? cost(spent) : '', made, needs ? `<span class="needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''].filter(Boolean).join(' · ');
    const open = menus.has(system);
    return `<section class="proj${sessions.length ? '' : ' quiet'}" data-project="${esc(system)}">
      <header class="proj-head" draggable="true" title="Drag to move ${esc(label)} up or down">
        <button type="button" class="proj-name" data-focus-project="${esc(system)}" title="${esc(label !== system ? `${label} (${system})` : label)}: show on the island">${esc(label)}</button>
        <span class="proj-meta">${meta}</span>
        <button type="button" class="ghost small" data-start="${esc(system)}" title="Start a new Claude Code session in ${esc(label)}, in VS Code">+ New</button>
        <button type="button" class="ghost small" data-menu="${esc(system)}" aria-expanded="${open}" aria-label="More for ${esc(label)}">⋯</button>
      </header>
      ${open ? `<div class="proj-menu"><button type="button" class="ghost small" data-move-up="${esc(system)}">Move up</button><button type="button" class="ghost small" data-move-down="${esc(system)}">Move down</button><button type="button" class="ghost small" data-rename-system="${esc(system)}">Rename</button><button type="button" class="ghost small" data-remove-system="${esc(system)}">Remove</button></div>` : ''}
      ${sessions.length ? `<ul class="rows">${sessions.map(rowHTML).join('')}</ul>` : ''}
      ${earlierHTML(system)}
    </section>`;
  }

  // Earlier conversations: what the project's sources still keep, read from the hub when unfolded.
  const liveIn = (system: string) => live.sessions.filter((s) => s.system === system).map((s) => s.id).sort().join();

  function earlierHTML(system: string): string {
    const fold = earlier.get(system);
    const toggle = `<button type="button" class="earlier-toggle" data-earlier="${esc(system)}" aria-expanded="${Boolean(fold)}">${fold ? '▾' : '▸'} Earlier conversations</button>`;
    if (!fold) return `<div class="earlier">${toggle}</div>`;
    const shown = new Set(live.sessions.map((s) => s.id));
    const list = fold.sessions.filter((s) => !shown.has(s.id));
    const body = fold.error ? `<p class="hint">${esc(fold.error)}</p>`
      : list.length ? `<ul class="rows">${list.map(pastHTML).join('')}</ul>`
      : `<p class="hint">${fold.loading ? 'Reading…' : 'No earlier conversations.'}</p>`;
    const more = fold.more ? `<button type="button" class="ghost small" data-earlier-more="${esc(system)}"${fold.loading ? ' disabled' : ''}>Show more</button>` : '';
    return `<div class="earlier">${toggle}${body}${more}</div>`;
  }

  const treeBadge = (s: BoardSession) => (s.worktree ? `<span class="badge tree" title="A git worktree of ${esc(s.repo ?? s.system)}">${esc(s.worktree)}</span>` : '');
  // In a group of repos (decision 47), the line under a session's title starts with its repo.
  const repoOf = (s: BoardSession) => (s.repo && !s.worktree ? `<span class="row-repo" title="Its repo, in ${esc(projectLabel(s.system, live.systems))}">${esc(s.repo)}</span>` : '');

  function pastHTML(s: BoardSession): string {
    const badge = treeBadge(s);
    const meta = [repoOf(s), esc(when(s.lastAt)), s.usage ? esc(cost(s.usage.costUsd)) : ''].filter(Boolean).join(' · ');
    return `<li class="row-item"><button type="button" class="row${options.current() === s.id ? ' open' : ''}" data-session="${esc(s.id)}" data-status="earlier" title="Open its story; Terminal or Continue in VS Code picks it up again">
      <span class="dot"></span>
      <span class="row-title">${esc(sessionLabel(s))}${badge}</span>
      <span class="row-meta">${meta}</span>
    </button><button type="button" class="ghost small row-rename" data-rename-session="${esc(s.id)}" title="Rename this session" aria-label="Rename ${esc(sessionLabel(s))}">✎</button></li>`;
  }

  async function loadEarlier(system: string, more = false) {
    const fold = earlier.get(system);
    if (!fold) return;
    Object.assign(fold, { loading: true, live: liveIn(system) });
    render();
    const before = more ? fold.sessions.at(-1)?.lastAt : undefined;
    const limit = more ? EARLIER_PAGE : Math.max(EARLIER_PAGE, fold.sessions.length);
    try {
      const res = await fetch(`/api/systems/${encodeURIComponent(system)}/history?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { sessions: Array<Omit<BoardSession, 'status' | 'seenIn' | 'subagents'>>; more: boolean };
      const got: BoardSession[] = body.sessions.map((s) => ({ ...s, status: null, seenIn: 'transcript', subagents: [] }));
      Object.assign(fold, { sessions: more ? [...fold.sessions, ...got] : got, more: body.more, error: '' });
    } catch {
      fold.error = "The hub couldn't read earlier conversations.";
    }
    fold.loading = false;
    if (earlier.get(system) === fold) render();
  }

  const pastById = (id: string) => [...earlier.values()].flatMap((f) => f.sessions).find((s) => s.id === id);

  // Another live session editing the same file (decision 58): the file, and who, on the row.
  function clashBadge(s: BoardSession): string {
    const first = s.clashes?.[0];
    if (!first) return '';
    const others = [...new Set(s.clashes?.map((c) => c.with))].map((id) => live.sessions.find((x) => x.id === id)).map((x) => (x ? (x.name ?? sessionLabel(x)) : 'another session'));
    const files = [...new Set(s.clashes?.map((c) => c.file))];
    const title = `${others.join(' and ')} also edited ${files.join(', ')} in the last hour`;
    return `<span class="badge clash" title="${esc(title)}">${BOLT}${esc(files.length === 1 ? folder(files[0]) : `${files.length} files`)}</span>`;
  }

  function rowHTML(s: BoardSession): string {
    const status = s.status ?? 'unknown';
    const badges = [
      treeBadge(s),
      s.permissionMode && s.permissionMode !== 'default' ? `<span class="badge" data-mode="${esc(s.permissionMode)}">${esc(s.permissionMode)}</span>` : '',
    ].join('');
    // One calling for me says how long it has waited (decision 57); any other, when it last did something.
    const calling = Boolean(s.calledAt && CALLING.has(s.status ?? ''));
    const since = calling ? '' : `<span data-since="${esc(s.lastAt)}"></span>`;
    // A clash goes first on the line under the title, which a long title never pushes out of view.
    const meta = [clashBadge(s), repoOf(s), s.lastTool ? esc(s.lastTool) : '', since, s.usage ? esc(cost(s.usage.costUsd)) : ''].filter(Boolean).join(' · ');
    const waitedFor = calling ? ` · <span data-waited="${esc(s.calledAt)}" title="How long it has waited for you"></span>` : '';
    const label = esc(sessionLabel(s));
    // A session calling for me glows until I read it (decision 55): by opening it, or with its read button.
    const read = s.unread ? `<button type="button" class="ghost small row-read" data-read-session="${esc(s.id)}" title="Mark as read: it stops glowing, and stays on the board" aria-label="Mark ${label} as read">${OPENED}</button>` : '';
    return `<li class="row-item live"><button type="button" class="row${options.current() === s.id ? ' open' : ''}${s.unread ? ' unread' : ''}" data-session="${esc(s.id)}" data-status="${esc(status)}">
      <span class="dot" title="${esc(statusLabel(s))}"></span>
      <span class="row-title">${s.name ? `<span class="row-name" title="Its mirling">${esc(s.name)}</span>` : ''}${label}${badges}</span>
      <span class="row-meta"><span class="row-status">${esc(statusLabel(s))}${waitedFor}</span> · ${meta}</span>
    </button><span class="row-actions">
      <button type="button" class="ghost small row-rename" data-rename-session="${esc(s.id)}" title="Rename this session" aria-label="Rename ${label}">✎</button>
      ${read}
      <button type="button" class="ghost small row-done" data-done-session="${esc(s.id)}" title="Done: off the board until it does something new. It stays in Earlier conversations." aria-label="Done with ${label}">${TICK}</button>
    </span></li>`;
  }

  // Relative times and countdowns move every second without redrawing.
  function tick() {
    for (const el of root.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = ago(el.dataset.since as string);
    for (const el of root.querySelectorAll<HTMLElement>('[data-waited]')) el.textContent = waited(el.dataset.waited as string);
    for (const el of root.querySelectorAll<HTMLElement>('[data-asked]')) {
      const left = Math.max(0, live.waitSeconds - (Date.now() - Date.parse(el.dataset.asked as string)) / 1000);
      el.textContent = `${Math.ceil(left)}s left`;
      const bar = el.closest('.prompt')?.querySelector<HTMLElement>('.bar i');
      if (bar) bar.style.width = `${(left / live.waitSeconds) * 100}%`;
    }
  }
  window.setInterval(tick, 1000);

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const pick = (attr: string) => (target.closest(`[data-${attr}]`) as HTMLElement | null)?.getAttribute(`data-${attr}`) ?? undefined;
    const answer = pick('answer');
    const promptId = pick('prompt-id');
    if (answer && promptId) {
      busy.add(promptId);
      render();
      void answerPrompt(promptId, answer as 'allow' | 'deny' | 'terminal').finally(() => { busy.delete(promptId); render(); });
      return;
    }
    const read = pick('read-session');
    if (read) return void markRead(read, true);
    const done = pick('done-session');
    if (done) return void doneWith(done).then((ok) => { if (ok) options.onDone(done); });
    const session = pick('session');
    if (session) return options.onSession(session);
    const project = pick('focus-project');
    if (project) return options.onProject(project);
    const start = pick('start');
    if (start) return void openStart(start, projectLabel(start, live.systems));
    const fold = pick('earlier');
    if (fold) {
      if (!earlier.delete(fold)) {
        earlier.set(fold, { sessions: [], more: false, loading: false, error: '', live: '' });
        void loadEarlier(fold);
      }
      return render();
    }
    const more = pick('earlier-more');
    if (more) return void loadEarlier(more, true);
    const menu = pick('menu');
    if (menu) {
      if (!menus.delete(menu)) menus.add(menu);
      return render();
    }
    const renameSession = pick('rename-session');
    if (renameSession) {
      const s = live.sessions.find((x) => x.id === renameSession) ?? pastById(renameSession);
      return void renameThing('session', renameSession, s ? sessionLabel(s) : renameSession).then(() => {
        if (s && !live.sessions.includes(s)) void loadEarlier(s.system);
      });
    }
    const up = pick('move-up') ?? pick('move-down');
    if (up) {
      const names = ordered();
      const i = names.indexOf(up);
      const j = pick('move-up') ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= names.length) return;
      [names[i], names[j]] = [names[j] as string, names[i] as string];
      return reorder(names);
    }
    const rename = pick('rename-system');
    if (rename) return void renameThing('system', rename, projectLabel(rename, live.systems));
    const remove = pick('remove-system');
    if (remove) {
      void removeThing('system', remove, projectLabel(remove, live.systems)).then((done) => {
        if (!done) return;
        menus.delete(remove);
      });
    }
  });

  // Dragging a project's heading moves it: a line shows where it will go, above or below the project
  // under the pointer.
  const marks = () => root.querySelectorAll('.drop-before, .drop-after');
  const where = (e: DragEvent) => {
    const over = (e.target as HTMLElement).closest<HTMLElement>('.proj[data-project]');
    if (!over || !dragging || over.dataset.project === dragging) return null;
    const box = over.getBoundingClientRect();
    return { over, after: e.clientY > box.top + box.height / 2 };
  };
  root.addEventListener('dragstart', (e) => {
    const head = (e.target as HTMLElement).closest<HTMLElement>('.proj-head');
    const section = head?.closest<HTMLElement>('.proj[data-project]');
    if (!head || !section?.dataset.project) return;
    dragging = section.dataset.project;
    section.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', dragging);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragover', (e) => {
    const spot = where(e);
    if (!spot) return;
    e.preventDefault();
    for (const el of marks()) el.classList.remove('drop-before', 'drop-after');
    spot.over.classList.add(spot.after ? 'drop-after' : 'drop-before');
  });
  root.addEventListener('drop', (e) => {
    const spot = where(e);
    const moving = dragging;
    if (!spot || !moving) return;
    e.preventDefault();
    const names = ordered().filter((n) => n !== moving);
    const at = names.indexOf(spot.over.dataset.project as string) + (spot.after ? 1 : 0);
    dragging = null;
    moveProject(moving, names[at] ?? null);
  });
  root.addEventListener('dragend', () => {
    dragging = null;
    for (const el of marks()) el.classList.remove('drop-before', 'drop-after');
    last = '';
    render();
  });

  return {
    render,
    past: pastById,
    showProject(name) {
      const el = root.querySelector<HTMLElement>(`[data-project="${CSS.escape(name)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el.classList.remove('flash');
      void el.offsetWidth; // restart the highlight
      el.classList.add('flash');
    },
  };
}
