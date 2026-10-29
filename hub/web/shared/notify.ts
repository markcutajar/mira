// Desktop notifications (decision 45): when a session starts waiting on me, fails, or finishes a turn
// that took a while, and Mira isn't in front of me, the system shows a notification. Clicking it
// brings Mira forward on that session. A browser asks once for leave to show them; the app has it.
// They name the session and the tool it asks for, never what it would run, so nothing of a session's
// content lands in the system's notification history.
// In the app, the same moments also put up Mira's own pop-up in the middle of the screen and flash
// its taskbar button, and they all go away once I've read the session (decision 55).

import { markRead, sessionLabel, type BoardSession, type PendingPrompt } from './format.ts';

/** What Mira's own pop-up shows for one session: what happened, its name, and where. */
export interface PopupCard {
  id: string;
  status: Worth;
  title: string;
  task?: string;
  body: string;
}

declare global {
  interface Window {
    /**
     * What the desktop app (decisions 43 and 55) adds to the page: bringing its window forward, its
     * pop-up and the flash of its taskbar button. All but `focus` are missing in an app started
     * before they existed, until it's restarted.
     */
    miraApp?: {
      focus(): void;
      flash?(): void;
      popup?(card: PopupCard): void;
      unpop?(id: string): void;
      onPopup?(handler: (action: 'open' | 'editor' | 'dismiss', id: string) => void): void;
    };
  }
}

const KEY = 'mira.notify';
// A moment's grace, so a prompt that arrives just after its session's status can be named.
const SETTLE_MS = 600;
// A turn shorter than this I was most likely watching, so its end isn't worth a notification.
const LONG_TURN_MS = 20_000;
const ICON = '/mirling.png';

type Worth = 'needs-me' | 'failed' | 'my-turn';
const HAPPENED: Record<Worth, string> = { 'needs-me': 'needs you', failed: 'failed', 'my-turn': 'is done' };

export interface NotifierOptions {
  /** The "Notify me" checkbox, remembered in this browser. */
  toggle: HTMLInputElement;
  sessions(): BoardSession[];
  pending(): PendingPrompt[];
  label(s: BoardSession): string;
  project(system: string): string;
  /** A notification was clicked: show its session. */
  onOpen(id: string): void;
}

export interface Notifier {
  /** Looks for sessions whose status changed since last time; call it whenever sessions or prompts change. */
  check(): void;
}

export function createNotifier(options: NotifierOptions): Notifier {
  const supported = 'Notification' in window;
  const { toggle } = options;
  let on = false;
  let primed = false;
  const last = new Map<string, { status: string | null; since: number }>();
  const shown = new Map<string, { status: Worth; note?: Notification }>();

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
  // Back in front of me, what they said is on screen.
  window.addEventListener('focus', () => { for (const id of [...shown.keys()]) forget(id); });

  // The pop-up's buttons: Open shows the session here, VS Code there, where the app has already opened
  // it, and closing the card reads it.
  window.miraApp?.onPopup?.((action, id) => {
    forget(id);
    if (action === 'open') {
      window.focus();
      options.onOpen(id);
    } else void markRead(id);
  });

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

  function fire(id: string, status: Worth): void {
    const s = options.sessions().find((x) => x.id === id);
    if (!s || s.status !== status || !s.unread || inFront()) return;
    window.miraApp?.flash?.();
    if (!on) return;
    forget(id);
    const { title, body } = words(s, status);
    const note = new Notification(title, { body, tag: `mira-${id}`, icon: ICON });
    note.onclick = () => {
      forget(id);
      window.miraApp?.focus();
      window.focus();
      options.onOpen(id);
    };
    note.onclose = () => { if (shown.get(id)?.note === note) delete shown.get(id)?.note; };
    // The pop-up has room for the session's name on a line of its own, so what happened stays in view.
    window.miraApp?.popup?.({ id, status, title: `${s.name ?? sessionLabel(s)} ${HAPPENED[status]}`, ...(s.name ? { task: sessionLabel(s) } : {}), body });
    shown.set(id, { status, note });
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
        last.set(s.id, { status: s.status, since: now });
        // One that's no longer true goes away.
        if (shown.has(s.id) && shown.get(s.id)?.status !== s.status) forget(s.id);
        if (!primed) continue;
        const longTurn = before?.status === 'working' && now - before.since >= LONG_TURN_MS;
        if (s.status === 'needs-me' || s.status === 'failed' || (s.status === 'my-turn' && longTurn)) {
          const status = s.status;
          setTimeout(() => fire(s.id, status), SETTLE_MS);
        }
      }
      for (const id of [...last.keys()]) {
        if (sessions.some((s) => s.id === id)) continue;
        last.delete(id);
        forget(id);
      }
      primed = true;
    },
  };
}
