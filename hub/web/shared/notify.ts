// Desktop notifications (decision 45): when a session starts waiting on me, fails, or finishes a turn
// that took a while, and Mira isn't in front of me, the system shows a notification. Clicking it
// brings Mira forward on that session. A browser asks once for leave to show them; the app has it.
// They name the session and the tool it asks for, never what it would run, so nothing of a session's
// content lands in the system's notification history.
// In the app, the same moments also put up Mira's own pop-up in the middle of the screen and flash
// its taskbar button, and they all go away once I've read the session (decision 55). The pop-up
// shows while Mira is in front too, for any session but the one I have open, and its cards stay until
// I deal with them: a finished turn's shows the session's last reply, read from its transcript and
// never kept, with a box to answer it from where I am; a permission prompt's shows what it would run,
// with Allow and Deny (decision 57). Two live sessions editing the same file call once (decision 58).
// Settings switch each way of calling on or off on its own: the system's notifications, the pop-up
// and the flash (decision 59).

import type { Story } from '../../src/sources.ts';
import { folder, markRead, sessionLabel, type BoardSession, type PendingPrompt } from './format.ts';

type Worth = 'needs-me' | 'failed' | 'my-turn';

/** One card on Mira's own pop-up: what happened, the session's name, where, and what it said or asks. */
export interface PopupCard {
  /** The card's own key: its session's ID, or for a clash, the pair's. */
  id: string;
  /** The session it opens, reads and answers. */
  session: string;
  status: Worth | 'clash';
  title: string;
  task?: string;
  body: string;
  reply?: string;
  canReply?: boolean;
  inTerminal?: boolean;
  prompt?: { id: string; summary?: string };
  clash?: { sessions: [string, string]; files: string[] };
}

/** What came of a pop-up card: opened here or in VS Code, closed, or answered from the card itself. */
type PopupResult = 'open' | 'editor' | 'dismiss' | 'replied' | 'pasted' | 'answered' | 'told';

declare global {
  interface Window {
    /**
     * What the desktop app (decisions 43, 55 and 57) adds to the page: bringing its window forward,
     * its pop-up and the flash of its taskbar button. All but `focus` are missing in an app started
     * before they existed, until it's restarted.
     */
    miraApp?: {
      focus(): void;
      flash?(): void;
      popup?(card: PopupCard): void;
      unpop?(id: string): void;
      onPopup?(handler: (action: PopupResult, id: string, session: string) => void): void;
      /** Takes Mira's update, closing the app and opening it again (decision 60); resolves to why not, or null. */
      update?(): Promise<string | null>;
    };
  }
}

const KEY = 'mira.notify';
const POPUP_KEY = 'mira.popup';
const FLASH_KEY = 'mira.flash';
const APP_ONLY = "This comes with Mira's app, which runs with npm run app.";
// A moment's grace, so a prompt that arrives just after its session's status can be named.
const SETTLE_MS = 600;
// A turn shorter than this I was most likely watching, so its end isn't worth a notification.
const LONG_TURN_MS = 20_000;
// Busy, whether at it or waiting on work it started (decision 56): one stretch, however it ends.
const BUSY = new Set(['working', 'waiting']);
const ICON = '/mirling.png';
const MAX_REPLY = 20_000;

const HAPPENED: Record<Worth, string> = { 'needs-me': 'needs you', failed: 'failed', 'my-turn': 'is done' };

export interface NotifierOptions {
  /** The desktop notifications switch, remembered in this browser. */
  toggle: HTMLInputElement;
  /** The app's pop-up and taskbar flash switches, on until switched off (decision 59). */
  popup: HTMLInputElement;
  flash: HTMLInputElement;
  sessions(): BoardSession[];
  pending(): PendingPrompt[];
  /** The session whose story is open, which calls for nobody while I'm looking at it. */
  current(): string | null;
  label(s: BoardSession): string;
  project(system: string): string;
  /** A notification was clicked: show its session. */
  onOpen(id: string): void;
}

export interface Notifier {
  /** Looks for sessions whose status changed since last time; call it whenever sessions or prompts change. */
  check(): void;
}

/** Two live sessions editing the same files (decision 58), keyed by the pair. */
interface Pair {
  key: string;
  one: BoardSession;
  other: BoardSession;
  files: string[];
}

function pairs(sessions: BoardSession[]): Map<string, Pair> {
  const found = new Map<string, Pair>();
  for (const s of sessions) {
    for (const c of s.clashes ?? []) {
      const other = sessions.find((x) => x.id === c.with);
      if (!other) continue;
      const [one, two] = s.id < other.id ? [s, other] : [other, s];
      const key = `clash-${one.id}-${two.id}`;
      const pair = found.get(key) ?? { key, one, other: two, files: [] };
      // Each file as the first of the two names it, from its own repo.
      if (s === one && !pair.files.includes(c.file)) pair.files.push(c.file);
      found.set(key, pair);
    }
  }
  return found;
}

// Whether the session runs in Mira's own terminal, where a reply is typed in as mine (decision 57).
async function inTerminal(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/terminal`);
    return res.ok && Boolean(((await res.json()) as { running?: boolean }).running);
  } catch {
    return false;
  }
}

/** A switch for one of the app's own ways of calling, on until switched off; off in a browser, which has neither. */
function appSwitch(input: HTMLInputElement, key: string, available: boolean, onChange?: (on: boolean) => void): () => boolean {
  let on = true;
  try { on = localStorage.getItem(key) !== 'off'; } catch { /* storage unavailable: on */ }
  input.checked = on && available;
  if (!available) {
    input.disabled = true;
    const label = input.closest('label');
    label?.setAttribute('title', APP_ONLY);
    label?.insertAdjacentHTML('beforeend', ' <span class="hint">· in the app</span>');
  }
  input.addEventListener('change', () => {
    on = input.checked;
    try { localStorage.setItem(key, on ? 'on' : 'off'); } catch { /* not remembered */ }
    onChange?.(on);
  });
  return () => on && available;
}

// The session's last reply, read from its transcript for the card and never kept.
async function lastReply(id: string): Promise<string | undefined> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/story?turns=1`);
    if (!res.ok) return undefined;
    const story = (await res.json()) as Story;
    const steps = story.turns.at(-1)?.steps ?? [];
    const text = steps.flatMap((step) => (step.kind === 'text' ? [step.text] : [])).at(-1)?.trim();
    if (!text) return undefined;
    return text.length > MAX_REPLY ? `…${text.slice(-MAX_REPLY)}` : text;
  } catch {
    return undefined;
  }
}

export function createNotifier(options: NotifierOptions): Notifier {
  const supported = 'Notification' in window;
  const { toggle } = options;
  let on = false;
  let primed = false;
  const last = new Map<string, { status: string | null; since: number }>();
  // What's showing, by card: a session's, or a clash's.
  const shown = new Map<string, { status: Worth | 'clash'; note?: Notification }>();
  // Clashes going on now, so each calls only once while it lasts.
  const clashing = new Set<string>();
  // Switching the pop-up off takes down the cards it has up.
  const popupOn = appSwitch(options.popup, POPUP_KEY, Boolean(window.miraApp?.popup), (now) => {
    if (!now) for (const id of shown.keys()) window.miraApp?.unpop?.(id);
  });
  const flashOn = appSwitch(options.flash, FLASH_KEY, Boolean(window.miraApp?.flash));

  const set = (value: boolean) => {
    on = value && supported && Notification.permission === 'granted';
    toggle.checked = on;
  };
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { /* storage unavailable */ }
  if (supported) set(stored ? stored === 'on' : Notification.permission === 'granted');
  else {
    toggle.disabled = true;
    toggle.closest('label')?.setAttribute('title', "This browser can't show desktop notifications.");
  }

  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    if (want && Notification.permission !== 'granted') {
      toggle.checked = false; // until the browser says yes
      if ((await Notification.requestPermission()) !== 'granted') {
        toggle.closest('label')?.setAttribute('title', "Notifications are blocked for this page. Allow them in the browser's site settings, then tick this again.");
        return;
      }
    }
    set(want);
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
  });

  const inFront = () => document.visibilityState === 'visible' && document.hasFocus();
  const forget = (id: string) => {
    if (!shown.has(id)) return;
    shown.get(id)?.note?.close();
    window.miraApp?.unpop?.(id);
    shown.delete(id);
  };
  // Back in front of me, the system's notifications have done their job; the pop-up's cards stay
  // until I deal with them.
  window.addEventListener('focus', () => {
    for (const s of shown.values()) {
      s.note?.close();
      delete s.note;
    }
  });

  // The pop-up's buttons: Open shows the session here, VS Code there, where the app has already
  // opened it; closing a session's card, or answering it from the card, reads it.
  window.miraApp?.onPopup?.((action, id, session) => {
    const clash = shown.get(id)?.status === 'clash';
    forget(id);
    if (action === 'open') {
      window.focus();
      options.onOpen(session);
    } else if (!clash) void markRead(session);
  });

  // What to say, each as switched on: the system's notification only while Mira isn't in front of
  // me, and the app's pop-up wherever I am, but never for the session I'm looking at. Null for
  // nothing to say.
  function speaks(session?: string): { note: boolean; card: boolean } | null {
    const front = inFront();
    if (!front && flashOn()) window.miraApp?.flash?.();
    const note = on && !front;
    const card = popupOn() && !(front && session !== undefined && options.current() === session);
    return note || card ? { note, card } : null;
  }

  function notify(id: string, title: string, body: string, opens: string): void {
    const note = new Notification(title, { body, tag: `mira-${id}`, icon: ICON });
    note.onclick = () => {
      forget(id);
      window.miraApp?.focus();
      window.focus();
      options.onOpen(opens);
    };
    note.onclose = () => { if (shown.get(id)?.note === note) delete shown.get(id)?.note; };
    const entry = shown.get(id);
    if (entry) entry.note = note;
  }

  function words(s: BoardSession, status: Worth): { title: string; body: string } {
    const label = options.label(s);
    const project = options.project(s.system);
    const title = `${label} ${HAPPENED[status]}`;
    if (status === 'needs-me') {
      const tool = options.pending().find((p) => p.sessionId === s.id)?.tool;
      return { title, body: tool ? `Asks to use ${tool}, in ${project}.` : `Waiting for you, in ${project}.` };
    }
    return { title, body: status === 'failed' ? `In ${project}.` : `Your turn, in ${project}.` };
  }

  async function fire(id: string, status: Worth): Promise<void> {
    const s = options.sessions().find((x) => x.id === id);
    if (!s || s.status !== status || !s.unread) return;
    const say = speaks(id);
    if (!say) return;
    forget(id);
    const entry = { status };
    shown.set(id, entry);
    const { title, body } = words(s, status);
    if (say.note) notify(id, title, body, id);
    if (!say.card || !window.miraApp?.popup) return;
    const prompt = status === 'needs-me' ? options.pending().find((p) => p.sessionId === id) : undefined;
    const [reply, terminal] = status === 'needs-me' ? [undefined, false] : await Promise.all([lastReply(id), inTerminal(id)]);
    // Read, answered or gone while its reply was being read: nothing to show.
    if (shown.get(id) !== entry) return;
    // The pop-up has room for the session's name on a line of its own, so what happened stays in view.
    window.miraApp.popup({
      id,
      session: id,
      status,
      title: `${s.name ?? sessionLabel(s)} ${HAPPENED[status]}`,
      ...(s.name ? { task: sessionLabel(s) } : {}),
      body,
      ...(reply ? { reply } : {}),
      ...((s.canMessage || terminal) && status !== 'needs-me' ? { canReply: true } : {}),
      ...(terminal ? { inTerminal: true } : {}),
      ...(prompt ? { prompt: { id: prompt.id, ...(prompt.summary ? { summary: prompt.summary } : {}) } } : {}),
    });
  }

  // Two sessions at the same file: the card names both and the files, and can tell them; the
  // system's notification names only the sessions.
  function fireClash(key: string): void {
    const pair = pairs(options.sessions()).get(key);
    if (!pair || shown.has(key)) return;
    const say = speaks();
    if (!say) return;
    shown.set(key, { status: 'clash' });
    const name = (s: BoardSession) => s.name ?? sessionLabel(s);
    const opens = (pair.one.lastAt > pair.other.lastAt ? pair.one : pair.other).id;
    const project = options.project(pair.one.system);
    const file = pair.files.length === 1 ? folder(pair.files[0]) : `${pair.files.length} files`;
    if (say.note) notify(key, `${name(pair.one)} and ${name(pair.other)} are editing the same file`, `In ${project}.`, opens);
    if (say.card) window.miraApp?.popup?.({
      id: key,
      session: opens,
      status: 'clash',
      title: `${name(pair.one)} and ${name(pair.other)} are both editing ${file}`,
      task: project,
      body: 'Both changed it in the last hour, so one may undo the other.',
      clash: { sessions: [pair.one.id, pair.other.id], files: pair.files.slice(0, 10) },
    });
  }

  return {
    check() {
      const now = Date.now();
      const sessions = options.sessions();
      for (const s of sessions) {
        // One read while it was showing goes away.
        if (!s.unread) forget(s.id);
        const before = last.get(s.id);
        if (before?.status === s.status) continue;
        const stillBusy = BUSY.has(before?.status ?? '') && BUSY.has(s.status ?? '');
        last.set(s.id, { status: s.status, since: stillBusy && before ? before.since : now });
        // One that's no longer true goes away.
        if (shown.has(s.id) && shown.get(s.id)?.status !== s.status) forget(s.id);
        if (!primed) continue;
        const longTurn = BUSY.has(before?.status ?? '') && before !== undefined && now - before.since >= LONG_TURN_MS;
        if (s.status === 'needs-me' || s.status === 'failed' || (s.status === 'my-turn' && longTurn)) {
          const status = s.status;
          setTimeout(() => void fire(s.id, status), SETTLE_MS);
        }
      }
      for (const id of [...last.keys()]) {
        if (sessions.some((s) => s.id === id)) continue;
        last.delete(id);
        forget(id);
      }
      // A clash calls once when it starts, and its card goes when it's over.
      const going = pairs(sessions);
      for (const key of going.keys()) {
        if (clashing.has(key)) continue;
        clashing.add(key);
        if (primed) setTimeout(() => fireClash(key), SETTLE_MS);
      }
      for (const key of [...clashing]) {
        if (going.has(key)) continue;
        clashing.delete(key);
        forget(key);
      }
      primed = true;
    },
  };
}
