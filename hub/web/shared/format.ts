// Small helpers the board and the sky share: escaping, labels, numbers and times.

import type { SessionView } from '../../src/roster.ts';
import type { PendingPrompt } from '../../src/permissions.ts';

/** A session as the hub sends it to the browser, with its mirling's name (decision 48), its title, worktree and repo in a group (decision 47) filled in, whether Mira can message it (decision 46), whether it's calling for me with something I haven't read (decision 55), and the files it and another live session both edited in the last hour (decision 58). */
export type BoardSession = SessionView & { name?: string; title?: string; worktree?: string; repo?: string; canMessage?: boolean; unread?: boolean; clashes?: Array<{ file: string; with: string }> };
export type { PendingPrompt };

const STATUS_LABEL: Record<string, string> = { 'needs-me': 'Needs you', failed: 'Failed', 'my-turn': 'Your turn', working: 'Working', waiting: 'Waiting', ended: 'Ended' };

// What a waiting session waits on, by the kind of task Claude Code names (decision 56).
const TASK_NAMES: Record<string, string> = { shell: 'a command', subagent: 'a subagent', monitor: 'a monitor', workflow: 'a workflow', teammate: 'a teammate', 'cloud session': 'a cloud session', 'MCP task': 'an MCP task' };

/** A session's status in words: "Your turn", or for one waiting, what on, such as "Waiting on a command". */
export function statusLabel(s: BoardSession): string {
  if (s.status !== 'waiting') return STATUS_LABEL[s.status ?? ''] ?? 'Unknown';
  const kinds = s.waitingOn ?? [];
  return `Waiting on ${kinds.length === 1 ? (TASK_NAMES[kinds[0] as string] ?? 'a task') : kinds.length ? `${kinds.length} tasks` : 'its tasks'}`;
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
export const folder = (path?: string) => (path ? path.split(/[\\/]/).filter(Boolean).pop() ?? '' : '');
export const short = (id: string) => String(id).slice(0, 8);
/** My name for a project, or its own. */
export const projectLabel = (system: string, systems: Array<{ name: string; label?: string }>) => systems.find((s) => s.name === system)?.label ?? system;
export const sessionLabel = (s: BoardSession) => s.title || `${folder(s.cwd) || s.system} · ${short(s.id)}`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

export function cost(usd: number): string {
  if (usd < 0.005) return '<$0.01';
  return usd >= 1000 ? `$${Math.round(usd).toLocaleString()}` : `$${usd.toFixed(2)}`;
}

/** `14:05` today, `25 Oct 14:05` on other days. */
export function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date().toDateString() ? time : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${time}`;
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

/** How long something has waited: `just now`, `12 min`, `3 h`, `2 d`. */
export function waited(iso: string): string {
  const m = Math.floor(Math.max(0, Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  return m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

let toastTimer = 0;

/** A short message at the bottom of the page. */
export function toast(text: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('p');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { if (el) el.hidden = true; }, 6000);
}

/** Tells the hub I've read what a session called me for (decision 55); `said` toasts if it couldn't. */
export async function markRead(id: string, said = false): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/read`, { method: 'POST' });
    if (!res.ok && said) toast((await res.text()) || `The hub couldn't mark it read (${res.status}).`);
  } catch {
    if (said) toast("The hub isn't reachable.");
  }
}

/** Answers a waiting permission prompt from Mira; `terminal` hands it back to the terminal at once. */
export async function answerPrompt(id: string, decision: 'allow' | 'deny' | 'terminal'): Promise<void> {
  try {
    const res = await fetch(`/api/prompts/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    if (res.status === 404) toast('That prompt is no longer waiting. It was answered or timed out, so check the terminal.');
    else if (!res.ok) toast(`The hub couldn't take that answer (${res.status}).`);
  } catch {
    toast("The hub isn't reachable, so answer in the terminal.");
  }
}
