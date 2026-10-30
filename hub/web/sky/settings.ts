// Settings (decisions 59 and 60): a panel under the top bar with each way Mira calls for me, switched
// on or off on its own, and where Mira's own copy stands against the repo it was cloned from, with
// the update to take when there is one. The switches belong to the notifier; this opens and closes
// the panel and keeps the update part current.

import type { UpdateStatus } from '../../src/update-status.ts';
import { esc, toast, waited } from '../shared/format.ts';

export interface Settings {
  /** Shows where Mira's update stands, as the hub last said. */
  update(status: UpdateStatus | null): void;
}

export interface SettingsElements {
  panel: HTMLElement;
  toggle: HTMLButtonElement;
  /** The top bar's "Update" button, there while an update is ready to take. */
  chip: HTMLButtonElement;
  count: HTMLElement;
  box: HTMLElement;
}

const SEEN_KEY = 'mira.updateSeen';
// An update finished this recently is worth a word when Mira comes back from it.
const FRESH_MS = 10 * 60 * 1000;
// A failed update stays mentioned in the panel for a day.
const FAILED_SHOWN_MS = 24 * 60 * 60 * 1000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (iso: string) => {
  const w = waited(iso);
  return w === 'just now' ? w : `${w} ago`;
};

export function createSettings(els: SettingsElements): Settings {
  const { panel, toggle, chip, count, box } = els;
  let status: UpdateStatus | null = null;
  let checking = false;
  let going = false;
  // The commit running when the update was taken, so the page reloads once the hub runs another, and
  // when the last update before it finished, so a new outcome on the same commit says it failed.
  let awaiting: { running: string; last: string } | null = null;
  let reloading = false;
  let said = '';
  const inApp = () => Boolean(window.miraApp?.update);

  // Under the top bar's right-hand box, lined up with its edge.
  function place() {
    const at = (toggle.closest('.glass') ?? toggle).getBoundingClientRect();
    panel.style.top = `${Math.round(at.bottom + 10)}px`;
    panel.style.right = `${Math.max(16, Math.round(window.innerWidth - at.right))}px`;
  }
  function show(open: boolean) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (!open) return;
    render();
    place();
  }
  toggle.addEventListener('click', () => show(panel.hidden !== false));
  chip.addEventListener('click', () => show(true));
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (!panel.hidden && !panel.contains(target) && !toggle.contains(target) && !chip.contains(target)) show(false);
  });
  // Escape inside the terminal belongs to the program in it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && !(e.target as HTMLElement | null)?.closest?.('.term-host')) show(false);
  });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });

  box.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-check]')) void check();
    else if (target.closest('[data-go]')) void go();
  });

  async function check() {
    checking = true;
    said = '';
    render();
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      if (res.ok) status = (await res.json()) as UpdateStatus;
      else said = (await res.text()) || `The hub couldn't check (${res.status}).`;
    } catch {
      said = "The hub isn't reachable.";
    }
    checking = false;
    render();
  }

  // In the app, the app takes the update, closing and opening again; in a browser the hub does, and
  // this page reloads once the hub is back on the new commit.
  async function go() {
    const from = { running: status?.running ?? '', last: status?.last?.at ?? '' };
    going = true;
    said = '';
    render();
    let failed: string | null = null;
    if (window.miraApp?.update) failed = await window.miraApp.update();
    else {
      try {
        const res = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) failed = (await res.text()) || `The hub couldn't update (${res.status}).`;
      } catch {
        failed = "The hub isn't reachable.";
      }
    }
    if (failed) {
      going = false;
      said = failed;
    } else awaiting = from;
    render();
  }

  // Once, in each browser: how the update just taken went.
  function announce(s: UpdateStatus) {
    const last = s.last;
    if (!last || Date.now() - Date.parse(last.at) > FRESH_MS) return;
    let seen = '';
    try { seen = localStorage.getItem(SEEN_KEY) ?? ''; } catch { /* storage unavailable */ }
    if (seen === last.at) return;
    try { localStorage.setItem(SEEN_KEY, last.at); } catch { /* said again next time */ }
    if (!last.ok) toast(`Mira couldn't update: ${last.error ?? 'something went wrong.'}`);
    else if (last.from !== last.to) toast(`Mira is updated, to ${last.to.slice(0, 7)}.`);
  }

  function render() {
    const s = status;
    chip.hidden = !(s?.state === 'available' && !s.updating && !going);
    count.textContent = String(s?.behind ?? 0);
    if (panel.hidden) return;
    if (!s) return void (box.innerHTML = '<p class="hint">Asking the hub…</p>');
    const parts: string[] = [];
    const behind = s.behind ?? 0;
    const shown = s.changes ?? [];
    const changes = () => `<p>${plural(behind, 'update')} on <code>${esc(s.upstream ?? 'its upstream')}</code>:</p>
      <ul>${shown.map((c) => `<li><code>${esc(c.hash)}</code><span>${esc(c.subject)}</span></li>`).join('')}</ul>
      ${behind > shown.length ? `<p class="hint">And ${behind - shown.length} more.</p>` : ''}`;
    const checkNow = `<button type="button" class="ghost small" data-check${checking ? ' disabled' : ''}>${checking ? 'Checking…' : 'Check now'}</button>`;
    if (going || s.updating) {
      parts.push(`<p>Updating… ${inApp() ? 'Mira closes, and opens again once the update is in.' : 'This page reloads once the update is in.'}</p>`);
    } else if (s.state === 'available') {
      const terminals = s.packages ? "It changes Mira's packages, so installing them takes a minute or so and ends your terminals. Their conversations are kept, ready to resume." : 'Your terminals keep running.';
      parts.push(changes(), `<p class="hint">${terminals} ${inApp() ? 'Mira closes, updates and opens again.' : 'The hub restarts and this page reloads.'}</p>`);
      parts.push(`<div class="update-go"><button type="button" class="go small" data-go>Update and restart</button>${checkNow}</div>`);
    } else {
      if (s.state === 'blocked' && behind) parts.push(changes(), `<p class="hint">${esc(s.reason ?? '')}</p>`);
      else if (s.state === 'current') parts.push(`<p>Up to date${s.running ? ` · <code>${esc(s.running)}</code>` : ''}</p>`);
      else parts.push(`<p>${esc(s.reason ?? "Mira hasn't checked for updates yet.")}</p>`);
      parts.push(`<div class="update-go">${checkNow}</div>`);
    }
    if (s.checkedAt && !going && !s.updating) parts.push(`<p class="hint">Checked ${ago(s.checkedAt)}.</p>`);
    const last = s.last;
    if (last && !last.ok && Date.now() - Date.parse(last.at) < FAILED_SHOWN_MS) parts.push(`<p class="hint warn">The update ${ago(last.at)} didn't go through: ${esc(last.error ?? 'something went wrong.')}</p>`);
    if (said) parts.push(`<p class="hint warn">${esc(said)}</p>`);
    box.innerHTML = parts.join('');
  }

  return {
    update(next) {
      // Back from an update taken here: on a new commit, the page reloads to run it; on the same one
      // with a new outcome, it didn't go through, and the panel says why. Anything else is the hub
      // before it closed. The new hub says so more than once, and a second reload would replace the
      // page that said how the update went.
      if (reloading) return;
      if (next && awaiting) {
        if (next.running !== awaiting.running) {
          reloading = true;
          return location.reload();
        }
        if ((next.last?.at ?? '') !== awaiting.last) {
          awaiting = null;
          going = false;
        }
      }
      status = next;
      if (next) announce(next);
      render();
    },
  };
}
