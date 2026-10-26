// The terminal host (decision 38): a small process of its own that runs the terminals the page opens
// (decision 36), so they carry on while the hub restarts or crashes. The hub starts it when a page
// first opens a terminal and relays each page to it; it ends once nothing has run in it and nobody
// has watched for a minute, or when `npm run hub:stop` asks. What I type goes straight to the
// program; Mira never types anything itself.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from '@lydell/node-pty';
import { endpoint, hostFile, line, onLines, PAGE_MESSAGES, type FromHost, type FromPage, type TerminalSpec, type ToHost } from './terminal-protocol.ts';

interface Running {
  process: pty.IPty;
  title: string;
  /** Recent output, replayed to a page that connects later. */
  output: string;
  viewers: Set<Socket>;
  exitCode: number | null;
}

const REPLAY_CHARS = 200_000;
const IDLE_MS = 60_000;
const clampSize = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(10, Math.min(500, Math.round(n))) : fallback);

export class TerminalHost {
  readonly server: Server = createServer((socket) => this.#connected(socket));
  readonly token = randomBytes(24).toString('hex');
  #by = new Map<string, Running>();
  #connections = new Set<Socket>();
  #idle: NodeJS.Timeout | undefined;
  #home: string | undefined;
  #onExit: () => void;
  #idleMs: number;

  constructor(options: { onExit?: () => void; idleMs?: number } = {}) {
    this.#onExit = options.onExit ?? (() => {});
    this.#idleMs = options.idleMs ?? IDLE_MS;
  }

  /** Listens where the hub looks for it, and leaves the secret where only I can read it. */
  listen(home: string): Promise<void> {
    this.#home = home;
    return new Promise((done, fail) => {
      this.server.once('error', fail);
      this.server.listen(endpoint(home), () => {
        mkdirSync(home, { recursive: true });
        writeFileSync(hostFile(home), JSON.stringify({ pid: process.pid, token: this.token }), { mode: 0o600 });
        this.#checkIdle();
        done();
      });
    });
  }

  /** The sessions whose terminal program is still running. */
  running(): string[] {
    return [...this.#by].filter(([, t]) => t.exitCode === null).map(([id]) => id);
  }

  /** Ends every terminal and stops listening. */
  close(): void {
    clearTimeout(this.#idle);
    for (const t of this.#by.values()) if (t.exitCode === null) t.process.kill();
    for (const socket of this.#connections) socket.destroy();
    this.#by.clear();
    this.server.close();
    if (this.#home && ownHostFile(this.#home, this.token)) rmSync(hostFile(this.#home), { force: true });
  }

  #connected(socket: Socket): void {
    this.#connections.add(socket);
    this.#checkIdle();
    let signedIn = false;
    let attached: string | null = null;
    let size = { cols: 100, rows: 30 };
    let spec: TerminalSpec | null = null;
    const send = (message: FromHost) => { if (!socket.destroyed) socket.write(line(message)); };

    onLines(socket, (text) => {
      let message: ToHost;
      try {
        message = JSON.parse(text) as ToHost;
      } catch {
        return void socket.destroy();
      }
      if (!signedIn) {
        if (message.type === 'hello' && message.token === this.token) signedIn = true;
        else socket.destroy();
      } else if (attached === null) {
        if (message.type === 'list') {
          send({ type: 'list', running: this.running() });
          socket.end();
        } else if (message.type === 'shutdown') {
          send({ type: 'list', running: this.running() });
          socket.end(() => {
            this.close();
            this.#onExit();
          });
        } else if (message.type === 'attach' && typeof message.id === 'string') {
          attached = message.id;
          spec = message.spec;
          size = { cols: clampSize(message.cols, 100), rows: clampSize(message.rows, 30) };
          this.#join(attached, socket, size, spec, send);
        }
      } else if (PAGE_MESSAGES.has(message.type)) {
        size = this.#fromPage(attached, socket, message as FromPage, size, spec);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.#connections.delete(socket);
      if (attached) this.#by.get(attached)?.viewers.delete(socket);
      this.#checkIdle();
    });
  }

  #join(id: string, socket: Socket, size: { cols: number; rows: number }, spec: TerminalSpec | null, send: (message: FromHost) => void): void {
    const t = this.#by.get(id);
    if (t) {
      t.viewers.add(socket);
      if (t.output) send({ type: 'output', data: t.output });
      // A size change makes a full-screen program draw itself again for the new viewer.
      if (t.exitCode === null) t.process.resize(size.cols, size.rows);
    }
    send({ type: 'state', running: t?.exitCode === null, title: t?.title ?? spec?.title, exitCode: t?.exitCode ?? null });
  }

  #fromPage(id: string, socket: Socket, message: FromPage, size: { cols: number; rows: number }, spec: TerminalSpec | null) {
    const t = this.#by.get(id);
    if (message.type === 'input' && typeof message.data === 'string' && t?.exitCode === null) t.process.write(message.data);
    else if (message.type === 'resize') {
      size = { cols: clampSize(message.cols, size.cols), rows: clampSize(message.rows, size.rows) };
      if (t?.exitCode === null) t.process.resize(size.cols, size.rows);
    } else if (message.type === 'start' && spec && t?.exitCode !== null) {
      // Anyone else watching the old, finished run watches the new one too.
      const next = this.#start(id, spec, size);
      for (const viewer of t?.viewers ?? []) next.viewers.add(viewer);
      next.viewers.add(socket);
      this.#tell(next, { type: 'state', running: true, title: next.title, exitCode: null });
    } else if (message.type === 'stop' && t?.exitCode === null) t.process.kill();
    return size;
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
    this.#checkIdle();
    process_.onData((data) => {
      t.output = (t.output + data).slice(-REPLAY_CHARS);
      this.#tell(t, { type: 'output', data });
    });
    process_.onExit(({ exitCode }) => {
      t.exitCode = exitCode;
      this.#tell(t, { type: 'state', running: false, title: t.title, exitCode });
      setTimeout(() => release(process_), 1000).unref(); // after the last output has flushed
      this.#checkIdle();
    });
    return t;
  }

  #tell(t: Running, message: FromHost): void {
    const text = line(message);
    for (const viewer of t.viewers) if (!viewer.destroyed) viewer.write(text);
  }

  // Nothing running and nobody connected for a while: the host's work is done.
  #checkIdle(): void {
    clearTimeout(this.#idle);
    if (this.#connections.size || this.running().length) return;
    this.#idle = setTimeout(() => {
      this.close();
      this.#onExit();
    }, this.#idleMs);
    this.#idle.unref();
  }
}

/** True if the host file is this host's, not one a newer host wrote. */
function ownHostFile(home: string, token: string): boolean {
  try {
    return (JSON.parse(readFileSync(hostFile(home), 'utf8')) as { token?: string }).token === token;
  } catch {
    return false;
  }
}

// On Windows, node-pty leaves its input socket and output worker open after the program ends,
// which would keep them around for the host's lifetime; let them go.
function release(terminal: pty.IPty): void {
  const agent = (terminal as unknown as { _agent?: { _inSocket?: { destroy(): void }; _conoutSocketWorker?: { dispose(): void } } })._agent;
  try {
    agent?._conoutSocketWorker?.dispose();
    agent?._inSocket?.destroy();
  } catch {
    // Best effort: these are node-pty's own fields, and may change.
  }
}

// A socket file left by a host that crashed is removed, but never one a live host answers on.
function staleSocket(where: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = connect(where);
    probe.once('connect', () => { probe.destroy(); done(false); });
    probe.once('error', () => done(true));
  });
}

// Run on its own, as the hub starts it: node hub/src/terminal-host.ts, with MIRA_HOME set.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const { miraHome } = await import('./config.ts');
  const host = new TerminalHost({ onExit: () => process.exit(0) });
  const quit = () => {
    host.close();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  try {
    if (process.platform !== 'win32' && (await staleSocket(endpoint(miraHome)))) rmSync(endpoint(miraHome), { force: true });
    await host.listen(miraHome);
    console.log(`${new Date().toISOString()} Terminal host ${process.pid} listening for the hub.`);
  } catch (error) {
    // Another host got there first; it carries on, and this one isn't needed.
    console.log(`${new Date().toISOString()} Terminal host not started: ${(error as Error).message}`);
    process.exit(0);
  }
}
