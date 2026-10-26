// The live link to the hub, shared by the board and the sky: sessions, waiting prompts and events
// over Server-Sent Events, plus telling the hub whether this page is on screen, so prompts only
// wait for an answer while someone is watching (decision 18).

import type { MiraEvent } from '../../../contracts/src/index.ts';
import type { BoardSession, PendingPrompt } from './format.ts';

/** A project, as the island lays it out: in the order it first appeared, with my name for it if I gave one. */
export interface SystemInfo {
  name: string;
  firstAt: string;
  lastAt: string;
  label?: string;
  /** Commits in the last 30 days, and the building levels they earn (decision 35). */
  growth?: { commits: number; docs: number; workshop: number; library: number };
}

export interface Live {
  systems: SystemInfo[];
  sessions: BoardSession[];
  pending: PendingPrompt[];
  /** Newest first, at most 80. */
  events: MiraEvent[];
  waitSeconds: number;
  connected: boolean;
}

export interface LiveOptions {
  /** The "Answer prompts here" checkbox, remembered in this browser. */
  hold?: HTMLInputElement | null;
  onConnection?(): void;
  onSystems?(): void;
  onSessions?(): void;
  onPending?(): void;
  /** A new event, as it happens. */
  onEvent?(event: MiraEvent): void;
  /** The list of recent events changed, from a new event or from history. */
  onEvents?(): void;
}

const HOLD_KEY = 'mira.answerHere';
const EVENTS_KEPT = 80;

export function connectLive(options: LiveOptions): Live {
  const live: Live = { systems: [], sessions: [], pending: [], events: [], waitSeconds: 60, connected: false };
  let viewer: string | null = null;
  let hold = true;
  try { hold = localStorage.getItem(HOLD_KEY) !== 'off'; } catch { /* storage unavailable: default on */ }
  if (options.hold) {
    options.hold.checked = hold;
    options.hold.addEventListener('change', () => {
      hold = Boolean(options.hold?.checked);
      try { localStorage.setItem(HOLD_KEY, hold ? 'on' : 'off'); } catch { /* not remembered */ }
      presence();
    });
  }
  const watching = () => hold && document.visibilityState === 'visible';

  function presence() {
    if (!viewer) return;
    fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, visible: watching() }) }).catch(() => {});
  }

  function addEvents(events: MiraEvent[]) {
    const seen = new Set(live.events.map((e) => e.id));
    live.events = [...live.events, ...events.filter((e) => !seen.has(e.id))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, EVENTS_KEPT);
  }

  const stream = new EventSource(`/api/stream?visible=${watching() ? 1 : 0}`);
  stream.addEventListener('hello', (e) => {
    const hello = JSON.parse((e as MessageEvent).data) as { viewer: string; waitSeconds: number };
    viewer = hello.viewer;
    Object.assign(live, { waitSeconds: hello.waitSeconds, connected: true });
    presence();
    options.onConnection?.();
  });
  stream.addEventListener('systems', (e) => {
    live.systems = JSON.parse((e as MessageEvent).data) as SystemInfo[];
    options.onSystems?.();
  });
  stream.addEventListener('sessions', (e) => {
    live.sessions = JSON.parse((e as MessageEvent).data) as BoardSession[];
    options.onSessions?.();
  });
  stream.addEventListener('pending', (e) => {
    live.pending = JSON.parse((e as MessageEvent).data) as PendingPrompt[];
    options.onPending?.();
  });
  stream.addEventListener('event', (e) => {
    const event = JSON.parse((e as MessageEvent).data) as MiraEvent;
    addEvents([event]);
    options.onEvent?.(event);
    options.onEvents?.();
  });
  // EventSource reconnects by itself; the hub sends a fresh hello when it does.
  stream.onerror = () => {
    viewer = null;
    live.connected = false;
    options.onConnection?.();
  };
  document.addEventListener('visibilitychange', presence);

  fetch('/api/events?limit=40')
    .then((res) => res.json() as Promise<MiraEvent[]>)
    .then((history) => {
      addEvents(history);
      options.onEvents?.();
    })
    .catch(() => { /* the live stream fills it in */ });

  return live;
}
