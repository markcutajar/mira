// What the hub and the terminal host say to each other (decision 38): one line of JSON per message,
// over a local pipe. A connection must open with the host's secret, kept in a file in my Mira home,
// or the host drops it.

import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { TerminalSpec } from './sources.ts';

export type { TerminalSpec };

/** What the page sends about its terminal, passed through the hub as it is. */
export type FromPage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'start' } | { type: 'stop' };
export type ToPage = { type: 'state'; running: boolean; title?: string; exitCode?: number | null } | { type: 'output'; data: string };

/** A connection opens with hello, then either attaches to one session's terminal or asks one thing. */
export type ToHost =
  | { type: 'hello'; token: string }
  | { type: 'attach'; id: string; spec: TerminalSpec | null; cols: number; rows: number }
  | { type: 'list' }
  | { type: 'shutdown' }
  /** Types my reply into a session's running terminal, then Enter (decision 57). */
  | { type: 'type'; id: string; text: string }
  | FromPage;
export type FromHost = ToPage | { type: 'list'; running: string[] } | { type: 'typed'; ok: boolean };

export const PAGE_MESSAGES = new Set<string>(['input', 'resize', 'start', 'stop']);

/** Where the host listens: a named pipe on Windows, a socket file elsewhere, one per Mira home. */
export function endpoint(home: string): string {
  if (process.platform !== 'win32') return join(home, 'terminals.sock');
  return `\\\\.\\pipe\\mira-terminals-${createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** The running host's process and secret, readable only by me. */
export const hostFile = (home: string) => join(home, 'terminals.json');

export const line = (message: ToHost | FromHost) => `${JSON.stringify(message)}\n`;

const MAX_LINE = 8 * 1024 * 1024;

/** Calls `each` with every complete line the socket receives. */
export function onLines(socket: Socket, each: (text: string) => void): void {
  let rest = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    rest += chunk;
    for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
      const text = rest.slice(0, end);
      rest = rest.slice(end + 1);
      if (text) each(text);
    }
    if (rest.length > MAX_LINE) socket.destroy();
  });
}
