// The live picture: every session and subagent with the status it shows now, worked out from events,
// plus the tokens and estimated cost each session has reported so far.
// Watch-only hooks arrive as background commands (decision 20), so events can land slightly out of
// order. Three rules keep the status honest:
//  1. An event older than the status already shown doesn't replace it.
//  2. Once a turn has ended, stragglers from that turn don't change the status.
//  3. A tool waiting for permission is still waiting, whatever its start event says.

import type { MiraEvent, Status } from '../../contracts/src/index.ts';
import type { FoundSession } from './sources.ts';

export interface SubagentView {
  id: string;
  name?: string;
  status: Status | null;
  lastAt: string;
}

export interface SessionUsage {
  tokens: number;
  costUsd: number;
}

export interface SessionView {
  id: string;
  source: string;
  system: string;
  status: Status | null;
  lastAt: string;
  cwd?: string;
  transcript?: string;
  lastTool?: string;
  permissionMode?: string;
  /** `transcript` until the first live event arrives for a session found at startup. */
  seenIn: 'events' | 'transcript';
  /** When it last called for me, as it happened: it started needing me, or a turn ended or failed. It's unread from then until I read it (decision 55). */
  calledAt?: string;
  /** While it's waiting: the kind of each piece of work it waits on, such as `shell` (decision 56). */
  waitingOn?: string[];
  subagents: SubagentView[];
  /** Totals from usage events: every turn that has finished, the session's and its subagents'. */
  usage?: SessionUsage;
}

interface Session extends Omit<SessionView, 'subagents'> {
  statusAt: string;
  endedTurns: string[];
  subagents: Map<string, SubagentView>;
}

const ENDED_TURNS_KEPT = 50;
// Long enough to see that a session ended, short enough not to linger (decision 30).
const ENDED_VISIBLE_MS = 5 * 60 * 1000;

/** How long a quiet session stays in view (decision 33): one still 'working', and any other. */
export interface QuietTimes {
  workingMs: number;
  idleMs: number;
}

export class Roster {
  #sessions = new Map<string, Session>();
  #quiet: QuietTimes;

  constructor(quiet: Partial<QuietTimes> = {}) {
    this.#quiet = { workingMs: 60 * 60 * 1000, idleMs: 12 * 60 * 60 * 1000, ...quiet };
  }

  apply(event: MiraEvent): void {
    const sessionId = event.actor.kind === 'subagent' ? event.actor.parent : event.actor.id;
    if (!sessionId) return;
    // Token counts add to a session the roster already knows; they never bring an old one back.
    if (event.type === 'usage.reported') return this.#addUsage(sessionId, event);
    const s = this.#session(sessionId, event);
    // A session stays in the project it started in (decision 27): the shell moving to another
    // folder is recorded, but changes neither its section nor its folder.
    const moved = event.type === 'session.moved';
    if (event.at >= s.lastAt) {
      s.lastAt = event.at;
      if (!moved) s.system = event.system;
    }
    if (event.ref?.transcript) s.transcript = event.ref.transcript;
    if (event.detail?.cwd && !moved) s.cwd = event.detail.cwd;
    if (event.detail?.permissionMode) s.permissionMode = event.detail.permissionMode;
    if (event.detail?.tool) s.lastTool = event.detail.tool;
    s.seenIn = 'events';

    if (event.actor.kind === 'subagent') {
      const sub = s.subagents.get(event.actor.id) ?? { id: event.actor.id, name: event.actor.name, status: null, lastAt: event.at };
      if (event.at >= sub.lastAt) {
        sub.lastAt = event.at;
        if (event.status) sub.status = event.status;
      }
      s.subagents.set(sub.id, sub);
      return;
    }

    if (!event.status || event.at < s.statusAt) return;
    const prompt = event.ref?.promptId;
    if (event.type === 'turn.ended' || event.type === 'turn.failed') {
      if (prompt && !s.endedTurns.includes(prompt)) s.endedTurns = [...s.endedTurns, prompt].slice(-ENDED_TURNS_KEPT);
    } else if (prompt && s.endedTurns.includes(prompt) && event.type !== 'session.ended') {
      return;
    }
    if (s.status === 'needs-me' && event.type === 'tool.started') return;
    // Starting to need me, and a turn that ends or fails, call for me; a session that only started
    // doesn't, nor one whose turn ended waiting on its own work, until it's done.
    const ends = event.status === 'my-turn' && (s.status === 'working' || s.status === 'needs-me' || s.status === 'waiting');
    if (event.status !== s.status && (ends || event.status === 'needs-me' || event.status === 'failed')) s.calledAt = event.at;
    if (event.status === 'waiting') s.waitingOn = event.detail?.waitingOn ?? [];
    else delete s.waitingOn;
    s.status = event.status;
    s.statusAt = event.at;
  }

  /** Adds sessions a source found at startup, unless events already know more about them. */
  seed(source: string, found: FoundSession[]): void {
    for (const f of found) {
      const known = this.#sessions.get(f.sessionId);
      if (known && known.lastAt >= f.lastAt) continue;
      const s = known ?? this.#blank(f.sessionId, source, f.system, f.lastAt);
      Object.assign(s, { system: f.system, cwd: f.cwd, transcript: f.transcript, lastAt: f.lastAt, status: f.status, statusAt: f.lastAt, seenIn: 'transcript' });
      this.#sessions.set(s.id, s);
    }
  }

  /**
   * Sessions worth showing. Ended ones stay a few minutes; one that has gone quiet leaves, since a
   * session that dies without ending sends nothing more, and comes back with its next event. A
   * session waiting on a prompt always stays (decision 33).
   */
  snapshot(now = Date.now()): SessionView[] {
    return [...this.#sessions.values()]
      .filter((s) => this.#inView(s, now))
      .sort((a, b) => a.system.localeCompare(b.system) || b.lastAt.localeCompare(a.lastAt))
      .map((s) => this.#view(s));
  }

  /** One session as it stands, including one that ended long ago. */
  get(id: string): SessionView | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#view(s) : undefined;
  }

  #inView(s: Session, now: number): boolean {
    const quiet = now - Date.parse(s.lastAt);
    if (s.status === 'needs-me') return true;
    if (s.status === 'ended') return quiet < ENDED_VISIBLE_MS;
    return quiet < (s.status === 'working' ? this.#quiet.workingMs : this.#quiet.idleMs);
  }

  #addUsage(sessionId: string, event: MiraEvent): void {
    const s = this.#sessions.get(sessionId);
    const u = event.usage;
    if (!s || !u) return;
    const usage = s.usage ?? { tokens: 0, costUsd: 0 };
    usage.tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    usage.costUsd = Math.round((usage.costUsd + (u.costUsd ?? 0)) * 1e6) / 1e6;
    s.usage = usage;
  }

  #view({ statusAt, endedTurns, subagents, usage, ...view }: Session): SessionView {
    return { ...view, subagents: [...subagents.values()], ...(usage ? { usage: { ...usage } } : {}) };
  }

  #session(id: string, event: MiraEvent): Session {
    let s = this.#sessions.get(id);
    if (!s) {
      s = this.#blank(id, event.source, event.system, event.at);
      this.#sessions.set(id, s);
    }
    return s;
  }

  #blank(id: string, source: string, system: string, at: string): Session {
    return { id, source, system, status: null, statusAt: '', lastAt: at, seenIn: 'events', endedTurns: [], subagents: new Map() };
  }
}
