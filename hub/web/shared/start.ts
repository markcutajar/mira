// Starting a new session in a project from Mira (decision 29): a prompt typed here goes into a new
// Claude Code chat in the project's VS Code window, and I send it from there. Mira never sends it.

import { showDialog } from './dialog.ts';
import { esc, toast } from './format.ts';

interface StartTarget {
  link: string;
  name: string;
  folder: string;
}

const MAX_PROMPT = 1500;

export async function openStart(system: string, label = system): Promise<void> {
  const box = showDialog('New session', `<form method="dialog" class="dialog-body">
    <header class="dialog-head"><h2>New session in ${esc(label)}</h2><button type="submit" class="ghost small" aria-label="Cancel">Cancel</button></header>
    <p class="meta" data-where>Finding the project's folder…</p>
  </form>`);
  let target: StartTarget | null = null;
  let problem = '';
  try {
    const res = await fetch(`/api/systems/${encodeURIComponent(system)}/start`);
    if (res.ok) target = (await res.json()) as StartTarget;
    else problem = res.status === 404 ? `Mira doesn't know a folder for ${system} yet. Start a session there once, and it will.` : `The hub couldn't look it up (${res.status}).`;
  } catch {
    problem = "The hub isn't reachable.";
  }
  if (!box.open) return;
  const where = box.querySelector('[data-where]') as HTMLElement;
  if (!target) {
    where.textContent = problem;
    return;
  }
  where.innerHTML = `Opens a new Claude Code chat in the VS Code window for <b>${esc(target.name)}</b>, in <span title="${esc(target.folder)}">${esc(target.folder)}</span>.`;
  where.insertAdjacentHTML('afterend', `
    <label class="dialog-field"><span class="eyebrow">What should it work on? (optional)</span>
      <textarea rows="5" maxlength="${MAX_PROMPT}" placeholder="Leave empty for a blank chat"></textarea></label>
    <p class="hint">Your prompt is typed into the chat for you. Nothing is sent until you press Enter in VS Code.</p>
    <div class="actions"><a class="go" href="${esc(target.link)}" data-open-start>Open in VS Code</a></div>`);
  const text = box.querySelector('textarea') as HTMLTextAreaElement;
  const open = box.querySelector('[data-open-start]') as HTMLAnchorElement;
  text.focus();
  // The link brings the project's window forward, since a click may hand VS Code the focus; the hub
  // then opens the new chat, which VS Code gives to the window now in front.
  open.addEventListener('click', () => {
    const name = (target as StartTarget).name;
    fetch(`/api/systems/${encodeURIComponent(system)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text.value }) })
      .then((res) => { if (!res.ok) void res.text().then((message) => toast(message || `The hub couldn't open it (${res.status}).`)); })
      .catch(() => toast("The hub isn't reachable."));
    toast(`Opening a new session in ${name}…`);
    box.close();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      open.click();
    }
  });
}

