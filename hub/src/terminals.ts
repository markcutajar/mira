// The hub's side of the terminals (decisions 36 and 38). The terminal host runs them, in a process
// of its own, so they outlive the hub; the hub starts the host when a page first needs it and relays
// each page's WebSocket to it. When the hub restarts, the page reconnects and picks up where it was.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { endpoint, hostFile, line, onLines, PAGE_MESSAGES, type FromHost, type TerminalSpec, type ToHost } from './terminal-protocol.ts';

export type { TerminalSpec } from './terminal-protocol.ts';

const HOST = fileURLToPath(new URL('./terminal-host.ts', import.meta.url));
const MAX_LOG = 1024 * 1024;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface TerminalsOptions {
  /** The Mira home, which says where the host listens. */
  home: string;
  /** Starts the host; by default as a hidden process of its own, which outlives the hub. */
  startHost?: () => void;
}

export class Terminals {
  #home: string;
  #startHost: () => void;
  #starting: Promise<boolean> | null = null;
  #links = new Set<Socket>();

  constructor(options: TerminalsOptions) {
    this.#home = options.home;
    this.#startHost = options.startHost ?? (() => startHostProcess(options.home));
  }

  /** True while a session's terminal program is still running. */
  async running(id: string): Promise<boolean> {
    return (await runningTerminals(this.#home))?.includes(id) ?? false;
  }

  /** Types my reply into a session's running terminal, then Enter (decision 57); false if none is running. */
  async type(id: string, text: string): Promise<boolean> {
    const reply = await ask(this.#home, { type: 'type', id, text });
    return reply?.type === 'typed' && reply.ok;
  }

  /** Relays a page to a session's terminal; `spec` says how to start it if it isn't running. */
  attach(id: string, page: WebSocket, spec: TerminalSpec | null, size: { cols: number; rows: number }): void {
    let link: Socket | null = null;
    let closed = false;
    const waiting: string[] = [];
    page.on('message', (raw) => {
      let message: { type?: unknown };
      try {
        message = JSON.parse(String(raw)) as { type?: unknown };
      } catch {
        return;
      }
      // Only what a page may say about its own terminal goes on to the host.
      if (typeof message?.type !== 'string' || !PAGE_MESSAGES.has(message.type)) return;
      const text = line(message as ToHost);
      if (link) link.write(text);
      else waiting.push(text);
    });
    page.on('error', () => {});
    page.on('close', () => {
      closed = true;
      link?.end();
    });

    void this.#host().then((socket) => {
      if (!socket) return void page.close(1011, "The terminal host didn't start.");
      if (closed) return void socket.end();
      link = socket;
      this.#links.add(socket);
      socket.write(line({ type: 'attach', id, spec, ...size }));
      for (const text of waiting.splice(0)) socket.write(text);
      onLines(socket, (text) => { if (page.readyState === page.OPEN) page.send(text); });
      socket.on('close', () => {
        this.#links.delete(socket);
        if (page.readyState === page.OPEN) page.close();
      });
    });
  }

  /** Lets go of every page's link, as the hub stops; the terminals carry on in the host. */
  closeAll(): void {
    for (const socket of this.#links) socket.end();
    this.#links.clear();
  }

  // A connection of its own for each page; the host is started once, however many pages ask at once.
  async #host(): Promise<Socket | null> {
    const open = await openHost(this.#home);
    if (open) return open;
    this.#starting ??= (async () => {
      this.#startHost();
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        const probe = await openHost(this.#home);
        probe?.destroy();
        if (probe) return true;
      }
      return false;
    })().finally(() => { this.#starting = null; });
    return (await this.#starting) ? openHost(this.#home) : null;
  }
}

/** The sessions whose terminals are running, or null when no host is. */
export async function runningTerminals(home: string): Promise<string[] | null> {
  const reply = await ask(home, { type: 'list' });
  return reply?.type === 'list' ? reply.running : null;
}

/** Ends the host and every terminal in it; resolves how many were running, or null if no host was. */
export async function stopTerminalHost(home: string): Promise<number | null> {
  const reply = await ask(home, { type: 'shutdown' });
  return reply?.type === 'list' ? reply.running.length : null;
}

async function ask(home: string, message: ToHost): Promise<FromHost | null> {
  const socket = await openHost(home);
  if (!socket) return null;
  return new Promise((done) => {
    const timer = setTimeout(() => { socket.destroy(); done(null); }, 2000);
    onLines(socket, (text) => {
      clearTimeout(timer);
      socket.end();
      try {
        done(JSON.parse(text) as FromHost);
      } catch {
        done(null);
      }
    });
    socket.on('close', () => { clearTimeout(timer); done(null); });
    socket.write(line(message));
  });
}

/** Connects to the running host and signs in, or resolves null if there isn't one. */
function openHost(home: string): Promise<Socket | null> {
  let token: string;
  try {
    token = (JSON.parse(readFileSync(hostFile(home), 'utf8')) as { token: string }).token;
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((done) => {
    const socket = connect(endpoint(home));
    socket.on('error', () => done(null));
    socket.once('connect', () => {
      socket.write(line({ type: 'hello', token }));
      done(socket);
    });
  });
}

function startHostProcess(home: string): void {
  mkdirSync(home, { recursive: true });
  const logFile = join(home, 'terminals.log');
  if (existsSync(logFile) && statSync(logFile).size > MAX_LOG) renameSync(logFile, `${logFile}.1`);
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, MIRA_HOME: home },
  });
  child.unref();
}
