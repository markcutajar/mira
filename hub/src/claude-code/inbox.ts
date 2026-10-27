// Messages from Mira into a running Claude Code session (decision 46), wherever it runs: VS Code,
// a terminal or Mira's own. Claude Code gives every session an inbox for messages from my other
// sessions, a named pipe on Windows and a Unix socket elsewhere, and tells its hooks the inbox's
// address and the token it asks for. The hooks pass both on with each event; the hub keeps them in
// memory and in a file only I can read, so a restart doesn't lose them, and forgets a session's
// once it ends. A message arrives as one from another session named Mira, which starts a turn
// when the session is idle, or is read between tool calls when it's working.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

export interface Inbox {
  socket: string;
  token: string;
  /** When a hook last named it. */
  at: string;
}

/** Who a message says it's from. */
export const SENDER = 'Mira';
export const MAX_MESSAGE = 20_000;
const KEPT_DAYS = 7;
const CONNECT_MS = 3000;
// Claude Code's own inbox addresses: a named pipe on Windows, a socket file elsewhere.
const PIPE = /^\\\\\.\\pipe\\(?:LOCAL\\)?cc-msg-[0-9a-f]{32}$/i;
const SOCKET = /^\/[\w./-]{1,200}\.sock$/;
const TOKEN = /^[\w-]{16,256}$/;

export const isInbox = (socket: unknown, token: unknown): boolean =>
  typeof socket === 'string' && typeof token === 'string' && (PIPE.test(socket) || SOCKET.test(socket)) && TOKEN.test(token);

export class Inboxes {
  #file: string | undefined;
  #by = new Map<string, Inbox>();

  constructor(file?: string) {
    this.#file = file;
    if (!file) return;
    try {
      const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Inbox>;
      const since = new Date(Date.now() - KEPT_DAYS * 86_400_000).toISOString();
      for (const [id, inbox] of Object.entries(kept)) if (isInbox(inbox?.socket, inbox?.token) && inbox.at >= since) this.#by.set(id, inbox);
    } catch {
      // None kept yet, or a file that's no use: hooks name them again.
    }
  }

  /** A hook named a session's inbox. */
  note(sessionId: string, socket: string, token: string, at = new Date()): void {
    if (!isInbox(socket, token)) return;
    const known = this.#by.get(sessionId);
    // Kept on every change, and once an hour as it's named again, so a long-lived one isn't dropped.
    const keep = !known || known.socket !== socket || known.token !== token || at.getTime() - Date.parse(known.at) > 3_600_000;
    this.#by.set(sessionId, { socket, token, at: at.toISOString() });
    if (keep) this.#keep();
  }

  forget(sessionId: string): void {
    if (this.#by.delete(sessionId)) this.#keep();
  }

  has(sessionId: string): boolean {
    return this.#by.has(sessionId);
  }

  /** Delivers a message; resolves to why it couldn't, or null once it's handed over. */
  send(sessionId: string, text: string): Promise<string | null> {
    const inbox = this.#by.get(sessionId);
    if (!inbox) return Promise.resolve("Mira doesn't know this session's inbox yet. It learns it from the session's next hook event, once the hooks pass it on (see hub/README.md).");
    const lines = `${JSON.stringify({ type: 'auth', token: inbox.token })}\n${JSON.stringify({ type: 'user', session_id: sessionId, from: SENDER, message: { role: 'user', content: text } })}\n`;
    return new Promise((done) => {
      const pipe = connect(inbox.socket, () => pipe.end(lines));
      const timer = setTimeout(() => {
        pipe.destroy();
        done("The session didn't take the message in time. It may be busy starting or stopping; try again in a moment.");
      }, CONNECT_MS);
      pipe.on('finish', () => {
        clearTimeout(timer);
        done(null);
      });
      pipe.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          this.forget(sessionId);
          done("That session isn't running any more, so nothing is there to take a message. Carry it on in a terminal or in VS Code.");
        } else done(`The message couldn't be delivered: ${err.message}`);
      });
    });
  }

  #keep(): void {
    if (!this.#file) return;
    try {
      writeFileSync(this.#file, JSON.stringify(Object.fromEntries(this.#by), null, 2), { mode: 0o600 });
      chmodSync(this.#file, 0o600);
    } catch (err) {
      console.warn(`Couldn't keep session inboxes in ${this.#file}: ${(err as Error).message}`);
    }
  }
}
