// The board, condensed down the left of the sky (decision 31): what's waiting for me, then every
// project with its sessions. A session row flies to its mirling and opens its story.

import { ago, answerPrompt, cost, esc, projectLabel, sessionLabel, short, STATUS_LABEL, type BoardSession, type PendingPrompt } from '../shared/format.ts';
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
  /** A project or session was removed from view. */
  onRemoved(kind: 'system' | 'session', key: string): void;
}

export interface Sidebar {
  render(): void;
  /** Scrolls to a project and highlights it, for a click on its section in the sky. */
  showProject(name: string): void;
}

const ORDER = ['needs-me', 'failed', 'my-turn', 'working', 'ended', null];
const rank = (s?: BoardSession) => ORDER.indexOf(s?.status ?? null);

export function createSidebar(root: HTMLElement, options: SidebarOptions): Sidebar {
  const { live } = options;
  const menus = new Set<string>(); // projects whose ⋯ menu is open
  const busy = new Set<string>(); // prompts being answered
  let last = '';

  function render() {
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
    const meta = sessions.length ? [`${active} active`, spent ? cost(spent) : '', needs ? `<span class="needs">${needs} need${needs === 1 ? 's' : ''} you</span>` : ''].filter(Boolean).join(' · ') : 'quiet';
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
    </section>`;
  }

  function rowHTML(s: BoardSession): string {
    const status = s.status ?? 'unknown';
    const badges = [
      s.worktree ? `<span class="badge tree" title="A git worktree of ${esc(s.system)}">${esc(s.worktree)}</span>` : '',
      s.permissionMode && s.permissionMode !== 'default' ? `<span class="badge" data-mode="${esc(s.permissionMode)}">${esc(s.permissionMode)}</span>` : '',
    ].join('');
    const meta = [s.lastTool ? esc(s.lastTool) : '', `<span data-since="${esc(s.lastAt)}"></span>`, s.usage ? esc(cost(s.usage.costUsd)) : ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="row${options.current() === s.id ? ' open' : ''}" data-session="${esc(s.id)}" data-status="${esc(status)}">
      <span class="dot" title="${esc(STATUS_LABEL[status] ?? 'Unknown')}"></span>
      <span class="row-title">${esc(sessionLabel(s))}${badges}</span>
      <span class="row-meta"><span class="row-status">${esc(STATUS_LABEL[status] ?? 'Unknown')}</span> · ${meta}</span>
    </button></li>`;
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
    const menu = pick('menu');
    if (menu) {
      if (!menus.delete(menu)) menus.add(menu);
      return render();
    }
    const rename = pick('rename-system');
    if (rename) return void renameThing('system', rename, projectLabel(rename, live.systems));
    const remove = pick('remove-system');
    if (remove) {
      void removeThing('system', remove, projectLabel(remove, live.systems)).then((done) => {
        if (!done) return;
        menus.delete(remove);
        options.onRemoved('system', remove);
      });
    }
  });

  return {
    render,
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
