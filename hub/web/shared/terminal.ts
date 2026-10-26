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
  stop(): void;
  focus(): void;
  dispose(): void;
}

type FromHub = { type: 'state'; running: boolean; title?: string; exitCode?: number | null } | { type: 'output'; data: string };

let loading: Promise<void> | null = null;

// xterm.js is only fetched the first time a terminal opens.
function loadXterm(): Promise<void> {
  loading ??= new Promise((done, fail) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/xterm.css';
    document.head.append(css);
    const script = (src: string) => new Promise<void>((ok, bad) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => ok();
      el.onerror = () => bad(new Error(`Couldn't load ${src}`));
      document.head.append(el);
    });
    script('/vendor/xterm.js').then(() => script('/vendor/xterm-fit.js')).then(done, fail);
  });
  return loading;
}

export async function openTerminal(host: HTMLElement, sessionId: string, onState: (state: TerminalState) => void): Promise<TerminalView> {
  await loadXterm();
  const globals = globalThis as unknown as { Terminal: typeof XTerm; FitAddon: { FitAddon: typeof Fit } };
  const term = new globals.Terminal({
    cursorBlink: true,
    fontFamily: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    scrollback: 5000,
    theme: { background: '#0b0d1a', foreground: '#ece8d9', cursor: '#ffd34d', cursorAccent: '#0b0d1a', selectionBackground: 'rgba(255, 211, 77, 0.3)' },
  });
  const fit = new globals.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
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
    focus: () => term.focus(),
    dispose: () => {
      resized.disconnect();
      typing.dispose();
      socket.close();
      term.dispose();
    },
  };
}
