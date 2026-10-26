// Terminals the page opens on a session (decision 36): the source's own command, such as
// `claude --resume`, running in a pseudo-terminal the hub owns and shown in the browser with
// xterm.js. A terminal keeps running when the page closes, and picks up where it was when the
// page comes back. What I type goes straight to the program; Mira never types anything itself.

import * as pty from '@lydell/node-pty';
import type { WebSocket } from 'ws';

export interface TerminalSpec {
  file: string;
  args: string[];
  cwd: string;
  /** What the page shows it's running, e.g. `claude --resume 673391f2`. */
  title: string;
}

interface Running {
  process: pty.IPty;
  title: string;
  /** Recent output, replayed to a page that connects later. */
  output: string;
  viewers: Set<WebSocket>;
  exitCode: number | null;
}

/** What the page and the hub send each other over the terminal's WebSocket, as JSON. */
type FromPage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'start' } | { type: 'stop' };
type ToPage = { type: 'state'; running: boolean; title?: string; exitCode?: number | null } | { type: 'output'; data: string };

const REPLAY_CHARS = 200_000;
const clampSize = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(10, Math.min(500, Math.round(n))) : fallback);

export class Terminals {
  #by = new Map<string, Running>();

  /** True while a session's terminal program is still running. */
  running(id: string): boolean {
    const t = this.#by.get(id);
    return Boolean(t && t.exitCode === null);
  }

  /** Connects a page to a session's terminal; `spec` says how to start it if it isn't running. */
  attach(id: string, socket: WebSocket, spec: TerminalSpec | null, size: { cols: number; rows: number }): void {
    const send = (message: ToPage) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };
    const state = () => {
      const t = this.#by.get(id);
      send({ type: 'state', running: this.running(id), title: t?.title ?? spec?.title, exitCode: t?.exitCode ?? null });
    };
    const join = (t: Running) => {
      t.viewers.add(socket);
      if (t.output) send({ type: 'output', data: t.output });
      // A size change makes a full-screen program draw itself again for the new viewer.
      if (t.exitCode === null) t.process.resize(size.cols, size.rows);
    };

    const current = this.#by.get(id);
    if (current) join(current);
    state();

    socket.on('message', (raw) => {
      let message: FromPage;
      try {
        message = JSON.parse(String(raw)) as FromPage;
      } catch {
        return;
      }
      const t = this.#by.get(id);
      if (message.type === 'input' && typeof message.data === 'string' && t?.exitCode === null) t.process.write(message.data);
      else if (message.type === 'resize') {
        size = { cols: clampSize(message.cols, size.cols), rows: clampSize(message.rows, size.rows) };
        if (t?.exitCode === null) t.process.resize(size.cols, size.rows);
      } else if (message.type === 'start' && spec && !this.running(id)) {
        // Anyone else watching the old, finished run watches the new one too.
        const next = this.#start(id, spec, size);
        for (const viewer of t?.viewers ?? []) next.viewers.add(viewer);
        next.viewers.add(socket);
        const started = JSON.stringify({ type: 'state', running: true, title: next.title, exitCode: null } satisfies ToPage);
        for (const viewer of next.viewers) if (viewer.readyState === viewer.OPEN) viewer.send(started);
      } else if (message.type === 'stop') this.stop(id);
    });
    socket.on('close', () => this.#by.get(id)?.viewers.delete(socket));
  }

  stop(id: string): void {
    const t = this.#by.get(id);
    if (t?.exitCode === null) t.process.kill();
  }

  closeAll(): void {
    for (const t of this.#by.values()) {
      if (t.exitCode === null) t.process.kill();
      for (const viewer of t.viewers) viewer.close();
    }
    this.#by.clear();
  }

  #start(id: string, spec: TerminalSpec, size: { cols: number; rows: number }): Running {
    const process_ = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: spec.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    const t: Running = { process: process_, title: spec.title, output: '', viewers: new Set(), exitCode: null };
    this.#by.set(id, t);
    process_.onData((data) => {
      t.output = (t.output + data).slice(-REPLAY_CHARS);
      const message = JSON.stringify({ type: 'output', data } satisfies ToPage);
      for (const viewer of t.viewers) if (viewer.readyState === viewer.OPEN) viewer.send(message);
    });
    process_.onExit(({ exitCode }) => {
      t.exitCode = exitCode;
      const message = JSON.stringify({ type: 'state', running: false, title: t.title, exitCode } satisfies ToPage);
      for (const viewer of t.viewers) if (viewer.readyState === viewer.OPEN) viewer.send(message);
      setTimeout(() => release(process_), 1000).unref(); // after the last output has flushed
    });
    return t;
  }
}

// On Windows, node-pty leaves its input socket and output worker open after the program ends,
// which would keep them around for the hub's lifetime; let them go.
function release(terminal: pty.IPty): void {
  const agent = (terminal as unknown as { _agent?: { _inSocket?: { destroy(): void }; _conoutSocketWorker?: { dispose(): void } } })._agent;
  try {
    agent?._conoutSocketWorker?.dispose();
    agent?._inSocket?.destroy();
  } catch {
    // Best effort: these are node-pty's own fields, and may change.
  }
}
