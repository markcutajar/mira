// Renaming and removing projects and sessions (decision 30). Names and removals are Mira's own:
// nothing in Claude Code or the repos changes, and a removed item comes back once it's active again.

import { showDialog } from './dialog.ts';
import { esc, toast } from './format.ts';

export type Kind = 'system' | 'session';
const NOUN: Record<Kind, string> = { system: 'project', session: 'session' };

/** Asks for a new name; resolves once it's saved, or not. */
export function renameThing(kind: Kind, key: string, current: string): Promise<void> {
  const box = showDialog(`Rename ${NOUN[kind]}`, `<form method="dialog" class="dialog-body">
    <header class="dialog-head"><h2>Rename this ${NOUN[kind]}</h2></header>
    <label class="dialog-field"><span class="eyebrow">Name</span><input type="text" maxlength="80" value="${esc(current)}"></label>
    <p class="hint">Shown on the board and in the sky. Leave it empty to go back to the original name.</p>
    <div class="actions"><button type="submit" class="go" value="save">Save</button><button type="submit" class="ghost" value="cancel">Cancel</button></div>
  </form>`);
  const input = box.querySelector('input') as HTMLInputElement;
  input.select();
  return new Promise((done) => {
    box.addEventListener('close', async function saved() {
      box.removeEventListener('close', saved);
      if (box.returnValue === 'save' && input.value.trim() !== current) await send('PUT', `/api/names/${kind}/${encodeURIComponent(key)}`, { name: input.value.trim() });
      done();
    });
  });
}

/** Asks before removing from view; resolves true if it was removed. */
export function removeThing(kind: Kind, key: string, label: string): Promise<boolean> {
  const what = kind === 'system'
    ? 'It leaves the board and the island, with its sessions, until something happens there again.'
    : "It leaves the board and the island until it's active again.";
  const box = showDialog(`Remove ${NOUN[kind]}`, `<form method="dialog" class="dialog-body">
    <header class="dialog-head"><h2>Remove ${esc(label)}?</h2></header>
    <p class="hint">${what} Nothing is deleted from Claude Code.</p>
    <div class="actions"><button type="submit" class="stop" value="remove">Remove</button><button type="submit" class="ghost" value="cancel">Cancel</button></div>
  </form>`);
  (box.querySelector('[value="cancel"]') as HTMLButtonElement).focus();
  return new Promise((done) => {
    box.addEventListener('close', async function chosen() {
      box.removeEventListener('close', chosen);
      done(box.returnValue === 'remove' && (await send('POST', `/api/remove/${kind}/${encodeURIComponent(key)}`)));
    });
  });
}

async function send(method: string, url: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) toast((await res.text()) || `The hub couldn't save that (${res.status}).`);
    return res.ok;
  } catch {
    toast("The hub isn't reachable.");
    return false;
  }
}
