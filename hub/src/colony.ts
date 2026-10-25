// The live picture: every session and subagent with the status it shows now, worked out from events.
// Watch-only hooks arrive as background commands (decision 20), so events can land slightly out of
// order. Three rules keep the status honest:
//  1. An event older than the status already shown doesn't replace it.
//  2. Once a turn has ended, stragglers from that turn don't change the status.
//  3. A tool waiting for permission is still waiting, whatever its start event says.

import type { MiraEvent, Status } from '../../contracts/src/index.ts';
import type { TranscriptSession } from './claude-code/transcripts.ts';

export interface SubagentView {
  id: string;
  name?: string;
  status: Status | null;
  lastAt: string;
}

export interface SessionView {
  id: string;
  system: string;
  status: Status | null;
  lastAt: string;
  cwd?: string;
  transcript?: string;
  lastTool?: string;
  permissionMode?: string;
  /** `transcript` until the first live event arrives for a session found at startup. */
  seenIn: 'events' | 'transcript';
  subagents: SubagentView[];
}

interface Session extends Omit<SessionView, 'subagents'> {
  statusAt: string;
  endedTurns: string[];
  subagents: Map<string, SubagentView>;
}

const ENDED_TURNS_KEPT = 50;
const ENDED_VISIBLE_MS = 60 * 60 * 1000;

export class Colony {
  #sessions = new Map<string, Session>();

  apply(event: MiraEvent): void {
    const sessionId = event.actor.kind === 'subagent' ? event.actor.parent : event.actor.id;
    if (!sessionId) return;
    const s = this.#session(sessionId, event);
    if (event.at >= s.lastAt) {
      s.lastAt = event.at;
      s.system = event.system;
    }
    if (event.ref?.transcript) s.transcript = event.ref.transcript;
    if (event.detail?.cwd) s.cwd = event.detail.cwd;
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
    s.status = event.status;
    s.statusAt = event.at;
  }

  /** Adds sessions found in transcripts at startup, unless events already know more about them. */
  seed(found: Array<TranscriptSession & { system: string }>): void {
    for (const f of found) {
      const known = this.#sessions.get(f.sessionId);
      if (known && known.lastAt >= f.lastAt) continue;
      const s = known ?? this.#blank(f.sessionId, f.system, f.lastAt);
      Object.assign(s, { system: f.system, cwd: f.cwd, transcript: f.transcript, lastAt: f.lastAt, status: f.status, statusAt: f.lastAt, seenIn: 'transcript' });
      this.#sessions.set(s.id, s);
    }
  }

  /** Sessions worth showing: everything still running, plus sessions that ended within the last hour. */
  snapshot(now = Date.now()): SessionView[] {
    return [...this.#sessions.values()]
      .filter((s) => s.status !== 'ended' || now - Date.parse(s.lastAt) < ENDED_VISIBLE_MS)
      .sort((a, b) => a.system.localeCompare(b.system) || b.lastAt.localeCompare(a.lastAt))
      .map(({ statusAt, endedTurns, subagents, ...view }) => ({ ...view, subagents: [...subagents.values()] }));
  }

  #session(id: string, event: MiraEvent): Session {
    let s = this.#sessions.get(id);
    if (!s) {
      s = this.#blank(id, event.system, event.at);
      this.#sessions.set(id, s);
    }
    return s;
  }

  #blank(id: string, system: string, at: string): Session {
    return { id, system, status: null, statusAt: '', lastAt: at, seenIn: 'events', endedTurns: [], subagents: new Map() };
  }
}
