// The terminal inside the story panel (decision 36): xterm.js draws what the hub's terminal sends,
// and my keystrokes go back to it. The hub runs the program, so closing the panel leaves it running.

import type { FitAddon as Fit } from '@xterm/addon-fit';
import type { Terminal as XTerm } from '@xterm/xterm';

export interface TerminalState {
  connected: boolean;
  running: boolean;
  title?: string;
  exitCode?: number | null;
}

export interface TerminalView {
  start(): void;
  /** Makes the text smaller or larger by one step; the size is remembered in this browser. */
  zoom(step: number): void;
  stop(): void;
  focus(): void;
  dispose(): void;
}

type FromHub = { type: 'state'; running: boolean; title?: string; exitCode?: number | null } | { type: 'output'; data: string };

// The look of my Windows Terminal: Cascadia Code, semi-light, 8 point, with each cell 1.2 times
// the font size high and 0.6 times wide. Sizes are in points, as there; the page needs pixels.
const LOOK = { family: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', weight: 350, cellHeight: 1.2, cellWidth: 0.6 };
const SIZE_KEY = 'mira.terminalPoints';
const SIZES = { min: 6, max: 18, start: 8 };

// Windows Terminal rounds each cell to whole pixels. xterm.js counts line height in multiples of
// the font's own height and letter spacing in pixels, so measure its plain cells and stretch them.
function applyLook(term: XTerm, host: HTMLElement, points: number): void {
  const px = (points * 4) / 3;
  term.options = { fontSize: px, lineHeight: 1, letterSpacing: 0 };
  const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!screen?.width || !term.cols || !term.rows) return; // not on screen yet; plain cells will do
  const dpr = devicePixelRatio || 1;
  const width = (screen.width / term.cols) * dpr;
  const height = (screen.height / term.rows) * dpr;
  const wantWidth = Math.round(LOOK.cellWidth * px * dpr);
  const wantHeight = Math.round(LOOK.cellHeight * px * dpr);
  term.options = { lineHeight: Math.max(1, (wantHeight + 0.01) / height), letterSpacing: wantWidth - width };
}

function savedSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    if (n >= SIZES.min && n <= SIZES.max) return n;
  } catch { /* storage unavailable */ }
  return SIZES.start;
}

let loading: Promise<void> | null = null;

// xterm.js is only fetched the first time a terminal opens. Its styles must be in place before it
// measures anything, or the first fit comes out too big.
function loadXterm(): Promise<void> {
  loading ??= new Promise((done, fail) => {
    const load = (el: HTMLLinkElement | HTMLScriptElement, src: string) => new Promise<void>((ok, bad) => {
      el.onload = () => ok();
      el.onerror = () => bad(new Error(`Couldn't load ${src}`));
      document.head.append(el);
    });
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/xterm.css' });
    const script = (src: string) => load(Object.assign(document.createElement('script'), { src }), src);
    Promise.all([load(css, css.href), script('/vendor/xterm.js').then(() => script('/vendor/xterm-fit.js'))]).then(() => done(), fail);
  });
  return loading;
}

export async function openTerminal(host: HTMLElement, sessionId: string, onState: (state: TerminalState) => void): Promise<TerminalView> {
  await loadXterm();
  const globals = globalThis as unknown as { Terminal: typeof XTerm; FitAddon: { FitAddon: typeof Fit } };
  let points = savedSize();
  const term = new globals.Terminal({
    cursorBlink: true,
    fontFamily: LOOK.family,
    fontWeight: LOOK.weight,
    scrollback: 5000,
    theme: { background: '#0b0d1a', foreground: '#ece8d9', cursor: '#ffd34d', cursorAccent: '#0b0d1a', selectionBackground: 'rgba(255, 211, 77, 0.3)' },
  });
  const fit = new globals.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  applyLook(term, host, points);
  fit.fit();

  const state: TerminalState = { connected: false, running: false };
  const report = () => onState({ ...state });
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sessions/${encodeURIComponent(sessionId)}/terminal?cols=${term.cols}&rows=${term.rows}`);
  const send = (message: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };

  socket.addEventListener('open', () => { state.connected = true; report(); });
  socket.addEventListener('close', () => { state.connected = false; report(); });
  socket.addEventListener('message', (e) => {
    const message = JSON.parse(String(e.data)) as FromHub;
    if (message.type === 'output') term.write(message.data);
    else {
      Object.assign(state, { running: message.running, title: message.title, exitCode: message.exitCode ?? null });
      report();
    }
  });
  const typing = term.onData((data) => send({ type: 'input', data }));

  // Keep the program's idea of the size in step with the panel.
  let frame = 0;
  const resized = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      fit.fit();
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    });
  });
  resized.observe(host);

  return {
    start: () => {
      term.reset();
      send({ type: 'start', cols: term.cols, rows: term.rows });
      term.focus();
    },
    stop: () => send({ type: 'stop' }),
    zoom: (step) => {
      points = Math.max(SIZES.min, Math.min(SIZES.max, points + step));
      applyLook(term, host, points);
      try { localStorage.setItem(SIZE_KEY, String(points)); } catch { /* not remembered */ }
      fit.fit();
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    },
    focus: () => term.focus(),
    dispose: () => {
      resized.disconnect();
      typing.dispose();
      socket.close();
      term.dispose();
    },
  };
}
