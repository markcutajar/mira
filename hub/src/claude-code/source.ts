// Claude Code as a Mira source: hooks in, transcripts read on demand. Token counts come from the
// transcripts, because no hook carries them; each finished turn is stored as one usage event,
// numbers only, so totals outlive Claude Code's own transcript clean-up.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { CONTRACT_VERSION, MiraEvent, type Actor } from '../../../contracts/src/index.ts';
import type { CostOf } from '../pricing.ts';
import type { SourceAdapter } from '../sources.ts';
import type { Place } from '../systems.ts';
import { Inboxes, MAX_MESSAGE } from './inbox.ts';
import { backgroundTasks, normalise, type HookPayload } from './normalise.ts';
import { activeSessions, helperAt, helpersOf, isInside, pastSessions, readStory, sessionTitle, turnsOf, writeTitle, type Turn } from './transcripts.ts';

export interface ClaudeCodeOptions {
  projectsDir: string;
  placeFor: (cwd: string | undefined) => Place;
  costOf: CostOf;
  /** How long after a turn ends to read its tokens, so the transcript has caught up. */
  usageDelayMs?: number;
  /** Where to keep each running session's inbox between restarts (decision 46); in memory only without it. */
  inboxFile?: string;
}

const SOURCE = 'claude-code';
const PROJECTS_KEPT = 1000;

export function claudeCode(options: ClaudeCodeOptions): SourceAdapter {
  const { projectsDir, placeFor, costOf } = options;
  const delay = options.usageDelayMs ?? 2000;
  const inboxes = new Inboxes(options.inboxFile);
  // Paths arrive in hook payloads, so only files under Claude Code's own folder are ever read.
  const inside = (file: string | undefined) => (file && isInside(projectsDir, file) ? file : undefined);

  const usageOf = (actor: Actor, system: string, turns: Turn[], ref: (turn: Turn) => MiraEvent['ref']) =>
    turns.filter((t) => t.state !== 'running').map((t) => usageEvent(actor, system, t, ref(t))).filter((e): e is MiraEvent => e !== null);

  // Each session's project, as its latest event outside a folder move named it.
  const projects = new Map<string, string>();
  const remember = (sessionId: string, system: string) => {
    projects.delete(sessionId);
    projects.set(sessionId, system);
    if (projects.size > PROJECTS_KEPT) projects.delete(projects.keys().next().value as string);
  };

  // What was still running when each session's last turn ended (decision 56). A turn that ends with
  // a subagent out, or with work that wasn't running at the last turn's end, is waiting on it; a
  // server left running from an earlier turn doesn't count. A session the hub only met after it
  // started has no last turn to go by, so only its subagents count.
  const running = new Map<string, Set<string>>();
  const ran = (sessionId: string, ids: Set<string>) => {
    running.delete(sessionId);
    running.set(sessionId, ids);
    if (running.size > PROJECTS_KEPT) running.delete(running.keys().next().value as string);
  };
  function waitingOn(sessionId: string, payload: HookPayload): string[] {
    const hook = payload.hook_event_name;
    // A new Claude Code process has nothing running yet.
    if (hook === 'SessionStart' && (payload.source === 'startup' || payload.source === 'resume')) ran(sessionId, new Set());
    if (hook !== 'Stop') return [];
    const tasks = backgroundTasks(payload);
    const before = running.get(sessionId);
    ran(sessionId, new Set(tasks.map((t) => t.id)));
    return tasks.filter((t) => t.kind === 'subagent' || (before !== undefined && !before.has(t.id))).map((t) => t.kind);
  }

  const helperEvents = (file: string, sessionId: string, system: string, name?: string) => {
    const helper = helperAt(file, costOf);
    const actor = compact({ kind: 'subagent' as const, id: helper.id, parent: sessionId, name: name ?? helper.name });
    return usageOf(actor, system, helper.turns, (t) => ({ subagentTranscript: file, ...(t.id.startsWith('turn-') ? {} : { promptId: t.id }) }));
  };

  return {
    id: SOURCE,

    // A session belongs to the project it started in (decision 27). When its shell changes folder,
    // the move is recorded under that project, not the folder it moved to. The hooks also pass on
    // the session's inbox, for messages from Mira (decision 46).
    ingest(payload, at, headers) {
      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
      const moved = payload.hook_event_name === 'CwdChanged';
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
      const known = projects.get(sessionId);
      const system = moved ? (known ?? placeFor(typeof payload.old_cwd === 'string' ? payload.old_cwd : cwd).system) : placeFor(cwd).system;
      if (!moved && sessionId) remember(sessionId, system);
      // Claude Code closes the inbox before SessionEnd's hook runs, so that one names none.
      const socket = headers?.['x-mira-inbox'];
      const token = headers?.['x-mira-inbox-token'];
      if (payload.hook_event_name === 'SessionEnd') inboxes.forget(sessionId);
      else if (SESSION_ID.test(sessionId) && socket && token) inboxes.note(sessionId, socket, token, at);
      return normalise(payload, { at: at.toISOString(), system, waitingOn: sessionId ? waitingOn(sessionId, payload) : [] });
    },

    discover(sinceMs) {
      return activeSessions(projectsDir, sinceMs).map((s) => ({ ...s, system: placeFor(s.cwd).system }));
    },

    history() {
      return pastSessions(projectsDir).map((s) => ({ ...s, system: placeFor(s.cwd).system }));
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

    // Written as Claude Code writes it, so Mira, VS Code and the terminal show the same name
    // whichever of them I renamed the session in (decision 37).
    rename(session, name) {
      const transcript = inside(session.transcript);
      const title = name.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
      if (!transcript || !title || !SESSION_ID.test(session.id) || basename(transcript) !== `${session.id}.jsonl` || !existsSync(transcript)) return false;
      writeTitle(transcript, session.id, title);
      return true;
    },

    story(session, { helper, turns }) {
      const transcript = inside(session.transcript);
      if (!transcript || (helper && !/^[\w-]{1,80}$/.test(helper))) return null;
      return readStory(transcript, { costOf, turns, helper });
    },

    // Into the session's inbox, which it reads wherever it runs (decision 46).
    canMessage(session) {
      return session.status !== 'ended' && inboxes.has(session.id);
    },

    message(session, text) {
      if (session.status === 'ended') return Promise.resolve('That session has ended. Carry it on in a terminal or in VS Code.');
      if (!text.trim() || text.length > MAX_MESSAGE) return Promise.resolve(`A message is 1 to ${MAX_MESSAGE} characters.`);
      return inboxes.send(session.id, text);
    },

    // The Claude Code extension opens a session in its chat panel from this link.
    continueAt(session) {
      if (!session.cwd || !SESSION_ID.test(session.id)) return null;
      return { folder: session.cwd, link: `vscode://anthropic.claude-code/open?session=${session.id}` };
    },

    // `claude --resume` in the session's folder. On Windows the npm-installed `claude` is a .cmd
    // shim, which only cmd.exe can run.
    terminalFor(session) {
      if (!session.cwd || !SESSION_ID.test(session.id)) return null;
      const args = ['--resume', session.id];
      return {
        file: process.platform === 'win32' ? 'cmd.exe' : 'claude',
        args: process.platform === 'win32' ? ['/d', '/c', 'claude', ...args] : args,
        cwd: session.cwd,
        title: `claude --resume ${session.id.slice(0, 8)}`,
      };
    },

    // Without a session, the same link opens a new chat; the extension types the prompt into its
    // input box and leaves sending it to me.
    startAt(_folder, prompt) {
      return { link: `vscode://anthropic.claude-code/open${prompt ? `?prompt=${encodeURIComponent(prompt)}` : ''}` };
    },
  };
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
