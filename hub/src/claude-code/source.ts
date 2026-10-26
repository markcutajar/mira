// Claude Code as a Mira source: hooks in, transcripts read on demand. Token counts come from the
// transcripts, because no hook carries them; each finished turn is stored as one usage event,
// numbers only, so totals outlive Claude Code's own transcript clean-up.

import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, MiraEvent, type Actor } from '../../../contracts/src/index.ts';
import type { CostOf } from '../pricing.ts';
import type { SourceAdapter } from '../sources.ts';
import type { Place } from '../systems.ts';
import { normalise } from './normalise.ts';
import { activeSessions, helperAt, helpersOf, isInside, readStory, sessionTitle, turnsOf, type Turn } from './transcripts.ts';

export interface ClaudeCodeOptions {
  projectsDir: string;
  placeFor: (cwd: string | undefined) => Place;
  costOf: CostOf;
  /** How long after a turn ends to read its tokens, so the transcript has caught up. */
  usageDelayMs?: number;
}

const SOURCE = 'claude-code';

export function claudeCode(options: ClaudeCodeOptions): SourceAdapter {
  const { projectsDir, placeFor, costOf } = options;
  const delay = options.usageDelayMs ?? 2000;
  // Paths arrive in hook payloads, so only files under Claude Code's own folder are ever read.
  const inside = (file: string | undefined) => (file && isInside(projectsDir, file) ? file : undefined);

  const usageOf = (actor: Actor, system: string, turns: Turn[], ref: (turn: Turn) => MiraEvent['ref']) =>
    turns.filter((t) => t.state !== 'running').map((t) => usageEvent(actor, system, t, ref(t))).filter((e): e is MiraEvent => e !== null);

  const helperEvents = (file: string, sessionId: string, system: string, name?: string) => {
    const helper = helperAt(file, costOf);
    const actor = compact({ kind: 'subagent' as const, id: helper.id, parent: sessionId, name: name ?? helper.name });
    return usageOf(actor, system, helper.turns, (t) => ({ subagentTranscript: file, ...(t.id.startsWith('turn-') ? {} : { promptId: t.id }) }));
  };

  return {
    id: SOURCE,

    ingest(payload, at) {
      const cwd = typeof payload.new_cwd === 'string' ? payload.new_cwd : typeof payload.cwd === 'string' ? payload.cwd : undefined;
      return normalise(payload, { at: at.toISOString(), system: placeFor(cwd).system });
    },

    discover(sinceMs) {
      return activeSessions(projectsDir, sinceMs).map((s) => ({ ...s, system: placeFor(s.cwd).system }));
    },

    catchUp(sinceMs) {
      return activeSessions(projectsDir, sinceMs).flatMap((s) => {
        const system = placeFor(s.cwd).system;
        const session = { kind: 'session' as const, id: s.sessionId };
        const own = usageOf(session, system, turnsOf(s.transcript, costOf), (t) => ({ transcript: s.transcript, ...(t.id.startsWith('turn-') ? {} : { promptId: t.id }) }));
        const helpers = helpersOf(s.transcript, costOf).flatMap((h) => helperEvents(h.file, s.sessionId, system));
        return [...own, ...helpers];
      });
    },

    followUp(event, emit) {
      if (event.source !== SOURCE) return;
      const later = (read: () => MiraEvent[]) => setTimeout(() => read().forEach(emit), delay).unref();
      if ((event.type === 'turn.ended' || event.type === 'turn.failed') && event.actor.kind === 'session') {
        const transcript = inside(event.ref?.transcript);
        const promptId = event.ref?.promptId;
        if (!transcript) return;
        later(() => {
          const turns = turnsOf(transcript, costOf);
          const turn = promptId ? turns.find((t) => t.id === promptId) : turns.at(-1);
          return turn ? usageOf(event.actor, event.system, [turn], () => ({ transcript, ...(promptId ? { promptId } : {}) })) : [];
        });
      }
      if (event.type === 'subagent.stopped' && event.actor.parent) {
        const file = inside(event.ref?.subagentTranscript);
        const sessionId = event.actor.parent;
        if (file) later(() => helperEvents(file, sessionId, event.system, event.actor.name));
      }
    },

    title(session) {
      const transcript = inside(session.transcript);
      return transcript ? sessionTitle(transcript) : undefined;
    },

    story(session, { helper, turns }) {
      const transcript = inside(session.transcript);
      if (!transcript || (helper && !/^[\w-]{1,80}$/.test(helper))) return null;
      return readStory(transcript, { costOf, turns, helper });
    },
  };
}

function usageEvent(actor: Actor, system: string, turn: Turn, ref: MiraEvent['ref']): MiraEvent | null {
  const u = turn.own;
  if (!u.input && !u.output && !u.cacheRead && !u.cacheWrite) return null;
  const parsed = MiraEvent.safeParse({
    v: CONTRACT_VERSION,
    // One event per turn whoever reports it first, so catch-up and live reports never double count.
    id: stableId(`usage:${actor.id}:${turn.id}`),
    at: turn.endedAt,
    source: SOURCE,
    system,
    actor,
    type: 'usage.reported',
    ...(turn.model ? { detail: { model: turn.model } } : {}),
    usage: compact({
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.cacheRead,
      cacheWriteTokens: u.cacheWrite,
      contextTokens: turn.contextTokens,
      costUsd: u.unpriced ? undefined : Math.round(u.costUsd * 1e6) / 1e6,
    }),
    ...(ref ? { ref } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** A UUID (version 5 layout) derived from a key, so the same turn always gets the same event ID. */
export function stableId(key: string): string {
  const h = createHash('sha1').update(key).digest('hex');
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
