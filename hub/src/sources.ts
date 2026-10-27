// What an agent source plugs into the hub (decision 22). Claude Code is the first; any other
// agent joins by providing the same pieces. Every piece is optional, so a source can start with
// ingest alone and add discovery or a story panel later.

import type { MiraEvent, Status } from '../../contracts/src/index.ts';
import type { SessionView } from './roster.ts';

/** How to run a session's own resume command in a terminal (decision 36). */
export interface TerminalSpec {
  file: string;
  args: string[];
  cwd: string;
  /** What the page shows it's running, e.g. `claude --resume 673391f2`. */
  title: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The hub's estimate, leaving out models it has no price for. */
  costUsd: number;
  /** Models with no price, so `costUsd` leaves them out. */
  unpriced?: string[];
}

/** A helper an agent started, like a Claude Code subagent. */
export interface StoryHelper {
  id: string;
  name?: string;
  description?: string;
  state: 'working' | 'done';
  tools: number;
  lastAt?: string;
  usage: UsageTotals;
}

export type StoryStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary?: string; failed?: boolean; helper?: StoryHelper }
  | { kind: 'note'; text: string }
  /** A message I sent while it worked, which it read between tools (decision 46). */
  | { kind: 'message'; text: string; via: 'mira' };

export interface StoryTurn {
  id: string;
  at: string;
  endedAt: string;
  /** Who started the turn: me, or the agent itself, for example when a background task finished. */
  from: 'you' | 'agent';
  /** Where I wrote it, when not in the session itself: Mira, for a message sent from its story (decision 46). */
  via?: 'mira';
  prompt?: string;
  steps: StoryStep[];
  state: 'running' | 'done' | 'interrupted' | 'failed';
  /** This turn's own tokens plus those of the helpers it started. */
  usage: UsageTotals;
}

/** A session's history for the panel, read from the source when the panel opens and never stored. */
export interface Story {
  sessionId: string;
  helperId?: string;
  model?: string;
  /** How full the context window was at the latest request. */
  contextTokens?: number;
  /** The whole session: every turn plus every helper. */
  usage: UsageTotals;
  turns: StoryTurn[];
  /** Older turns left out; ask for more with `turns`. */
  earlier: number;
}

export interface FoundSession {
  sessionId: string;
  system: string;
  cwd: string;
  lastAt: string;
  status: Status;
  transcript: string;
}

/** An earlier session, as its source keeps it, for picking it up again (decision 40). */
export interface PastSession extends FoundSession {
  title?: string;
}

export interface SourceAdapter {
  /** The source's ID, as in `/ingest/<id>` and the envelope's `source`. */
  id: string;
  /** Turns one payload sent to `/ingest/<id>` into an event, at the time it fired; `headers` are the request's, in lower case. */
  ingest?(payload: Record<string, unknown>, at: Date, headers?: Record<string, string | undefined>): MiraEvent | null;
  /** Sessions active since `sinceMs`, for the picture at startup. */
  discover?(sinceMs: number): FoundSession[];
  /** Every earlier session the source still keeps, for the board's history; read when asked, never stored. */
  history?(): PastSession[];
  /** Events that fill gaps left while the hub was stopped, such as the token use of turns that ended. */
  catchUp?(sinceMs: number): MiraEvent[];
  /** Events that follow from one just recorded, such as a turn's token use once it ends. */
  followUp?(event: MiraEvent, emit: (event: MiraEvent) => void): void;
  /** A display title for a session. */
  title?(session: SessionView): string | undefined;
  /** Renames a session where its source keeps names, so the source's own tools show it too (decision 37). False if it can't. */
  rename?(session: SessionView, name: string): boolean;
  /** The session's story, or one helper's, for the panel. */
  story?(session: SessionView, options: { helper?: string; turns: number }): Story | null;
  /** Where to carry a session on in an editor: its folder, and a link that opens the session there. */
  continueAt?(session: SessionView): { folder: string; link: string } | null;
  /** A link that starts a new session in a project folder, with a prompt typed in for me to send (decision 29). */
  startAt?(folder: string, prompt?: string): { link: string } | null;
  /** The command that carries a session on in a terminal the page shows (decision 36). */
  terminalFor?(session: SessionView): TerminalSpec | null;
  /** True when Mira can send this running session a message (decision 46). */
  canMessage?(session: SessionView): boolean;
  /** Sends a running session my message, wherever it runs; resolves to why not, or null once it's delivered. */
  message?(session: SessionView, text: string): Promise<string | null>;
}

export const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });

export function addUsage(into: UsageTotals, more: UsageTotals): UsageTotals {
  into.input += more.input;
  into.output += more.output;
  into.cacheRead += more.cacheRead;
  into.cacheWrite += more.cacheWrite;
  into.costUsd += more.costUsd;
  const unpriced = new Set([...(into.unpriced ?? []), ...(more.unpriced ?? [])]);
  if (unpriced.size) into.unpriced = [...unpriced];
  return into;
}
