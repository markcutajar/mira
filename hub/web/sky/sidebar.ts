// The board, condensed down the left of the sky (decision 31): what's waiting for me, then every
// project with its sessions and, folded away, its earlier conversations (decision 40). A session row
// flies to its mirling and opens its story.

import { ago, answerPrompt, cost, esc, projectLabel, sessionLabel, short, STATUS_LABEL, when, type BoardSession, type PendingPrompt } from '../shared/format.ts';
import type { Live } from '../shared/live.ts';
import { removeThing, renameThing } from '../shared/manage.ts';
import { openStart } from '../shared/start.ts';

export interface SidebarOptions {
  live: Live;
  /** The session whose story is open, to mark its row. */
  current(): string | null;
  /** A session row was clicked. */
  onSession(id: string): void;
  /** A project's name was clicked. */
  onProject(name: string): void;
}

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

const ORDER = ['needs-me', 'failed', 'my-turn', 'working', 'ended', null];
const rank = (s?: BoardSession) => ORDER.indexOf(s?.status ?? null);

export function createSidebar(root: HTMLElement, options: SidebarOptions): Sidebar {
  const { live } = options;
  const menus = new Set<string>(); // projects whose ⋯ menu is open
  const busy = new Set<string>(); // prompts being answered
  const earlier = new Map<string, Fold>(); // projects whose earlier conversations are unfolded
  let last = '';

  function render() {
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

  // Projects with sessions first, the one needing me most at the top; quiet projects after.
  function projectsHTML(): string {
    const names = [...new Set([...live.systems.map((s) => s.name), ...live.sessions.map((s) => s.system)])];
    const groups = names.map((name) => ({
      name,
      sessions: live.sessions.filter((s) => s.system === name).sort((a, b) => rank(a) - rank(b) || b.lastAt.localeCompare(a.lastAt)),
    }));
    groups.sort((a, b) => {
      if (!a.sessions.length || !b.sessions.length) return Number(!a.sessions.length) - Number(!b.sessions.length);
      return rank(a.sessions[0]) - rank(b.sessions[0]) || (b.sessions[0]?.lastAt ?? '').localeCompare(a.sessions[0]?.lastAt ?? '');
    });
    if (!groups.length) return '<p class="hint side-empty">No projects yet. Start a Claude Code session in any repo and it appears here, and on the island.</p>';
    return groups.map(({ name, sessions }) => projectHTML(name, sessions)).join('');
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
      <header class="proj-head">
        <button type="button" class="proj-name" data-focus-project="${esc(system)}" title="${esc(label !== system ? `${label} (${system})` : label)}: show on the island">${esc(label)}</button>
        <span class="proj-meta">${meta}</span>
        <button type="button" class="ghost small" data-start="${esc(system)}" title="Start a new Claude Code session in ${esc(label)}, in VS Code">+ New</button>
        <button type="button" class="ghost small" data-menu="${esc(system)}" aria-expanded="${open}" aria-label="More for ${esc(label)}">⋯</button>
      </header>
      ${open ? `<div class="proj-menu"><button type="button" class="ghost small" data-rename-system="${esc(system)}">Rename</button><button type="button" class="ghost small" data-remove-system="${esc(system)}">Remove</button></div>` : ''}
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

  function rowHTML(s: BoardSession): string {
    const status = s.status ?? 'unknown';
    const badges = [
      treeBadge(s),
      s.permissionMode && s.permissionMode !== 'default' ? `<span class="badge" data-mode="${esc(s.permissionMode)}">${esc(s.permissionMode)}</span>` : '',
    ].join('');
    const meta = [repoOf(s), s.lastTool ? esc(s.lastTool) : '', `<span data-since="${esc(s.lastAt)}"></span>`, s.usage ? esc(cost(s.usage.costUsd)) : ''].filter(Boolean).join(' · ');
    return `<li class="row-item"><button type="button" class="row${options.current() === s.id ? ' open' : ''}" data-session="${esc(s.id)}" data-status="${esc(status)}">
      <span class="dot" title="${esc(STATUS_LABEL[status] ?? 'Unknown')}"></span>
      <span class="row-title">${s.name ? `<span class="row-name" title="Its mirling">${esc(s.name)}</span>` : ''}${esc(sessionLabel(s))}${badges}</span>
      <span class="row-meta"><span class="row-status">${esc(STATUS_LABEL[status] ?? 'Unknown')}</span> · ${meta}</span>
    </button><button type="button" class="ghost small row-rename" data-rename-session="${esc(s.id)}" title="Rename this session" aria-label="Rename ${esc(sessionLabel(s))}">✎</button></li>`;
  }

  // Relative times and countdowns move every second without redrawing.
  function tick() {
    for (const el of root.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = ago(el.dataset.since as string);
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
