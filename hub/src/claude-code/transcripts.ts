// The one module that reads Claude Code transcripts (decision 5). Their format is internal to
// Claude Code and changes between releases, so every read is defensive: anything unexpected is
// skipped, never thrown. What it reads is held in memory for the panel and never stored.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Status } from '../../../contracts/src/index.ts';
import { summarise } from '../permissions.ts';
import type { CostOf, MessageTokens } from '../pricing.ts';
import { addUsage, emptyUsage, type Story, type StoryHelper, type StoryStep, type StoryTurn, type UsageTotals } from '../sources.ts';

export interface TranscriptSession {
  sessionId: string;
  cwd: string;
  lastAt: string;
  status: Status;
  transcript: string;
}

const TAIL_BYTES = 256 * 1024;
const MAX_TEXT = 20_000;

/** Sessions whose transcript changed since `sinceMs`, with where each one stands. */
export function activeSessions(projectsDir: string, sinceMs: number): TranscriptSession[] {
  const found: TranscriptSession[] = [];
  for (const project of list(projectsDir)) {
    for (const file of list(join(projectsDir, project))) {
      if (!file.endsWith('.jsonl')) continue;
      const transcript = join(projectsDir, project, file);
      try {
        const stat = statSync(transcript);
        if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
        const session = lastState(readTail(transcript, stat.size), transcript);
        if (session) found.push(session);
      } catch {
        // An unreadable transcript is skipped.
      }
    }
  }
  return found;
}

/** Reads the latest main-conversation message: where the session is, and whether Claude still had work in hand. */
export function lastState(tail: string, transcript: string): TranscriptSession | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parse(lines[i]);
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain === true) continue;
    const { sessionId, cwd, timestamp } = entry;
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || typeof timestamp !== 'string') continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const finished = entry.type === 'assistant' && message?.stop_reason === 'end_turn';
    return { sessionId, cwd, lastAt: timestamp, status: finished ? 'my-turn' : 'working', transcript };
  }
  return null;
}

/** True when `file` lies inside `dir`. On Windows, a file on another drive is never inside. */
export function isInside(dir: string, file: string): boolean {
  const rel = relative(resolve(dir), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const titles = new Map<string, { mtimeMs: number; title: string | undefined }>();

/** The session's latest title, as Claude Code wrote it into the transcript. Read on demand and cached in memory, never stored. */
export function sessionTitle(transcript: string): string | undefined {
  try {
    const stat = statSync(transcript);
    const cached = titles.get(transcript);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.title;
    const title = latestTitle(readTail(transcript, stat.size));
    titles.set(transcript, { mtimeMs: stat.mtimeMs, title });
    return title;
  } catch {
    return undefined;
  }
}

export function latestTitle(tail: string): string | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parse(lines[i]);
    if (entry?.type !== 'ai-title' || typeof entry.aiTitle !== 'string') continue;
    const title = entry.aiTitle.trim();
    return title ? title.slice(0, 80) : undefined;
  }
  return undefined;
}

// -- The story: what happened, turn by turn --

type Step = { kind: 'text'; text: string } | { kind: 'tool'; id?: string; name: string; summary?: string };

export type Entry =
  | { kind: 'prompt'; at: string; promptId?: string; from: 'you' | 'agent'; text: string }
  | { kind: 'reply'; at: string; messageId: string; model?: string; steps: Step[]; tokens?: MessageTokens; stop?: string; failed: boolean }
  | { kind: 'result'; at: string; toolUseId: string; failed: boolean }
  | { kind: 'note'; at: string; text: string }
  | { kind: 'interrupted'; at: string };

/** One turn as read, before helpers are attached. `own` counts this conversation's tokens only. */
export interface Turn extends Omit<StoryTurn, 'usage' | 'steps'> {
  steps: Array<StoryStep & { id?: string }>;
  own: UsageTotals;
  model?: string;
  contextTokens?: number;
}

/** Turns transcript lines into entries. `sidechain` is true for a subagent's own transcript. */
export function parseLines(text: string, sidechain = false): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    const raw = parse(line);
    if (raw) entries.push(...toEntries(raw, sidechain));
  }
  return entries;
}

function toEntries(raw: Record<string, unknown>, sidechain: boolean): Entry[] {
  const at = typeof raw.timestamp === 'string' ? raw.timestamp : undefined;
  if (!at || (!sidechain && raw.isSidechain === true)) return [];
  if (raw.type === 'system') return raw.subtype === 'compact_boundary' ? [{ kind: 'note', at, text: 'Conversation compacted' }] : [];
  const message = raw.message as Record<string, unknown> | undefined;
  if (!message) return [];
  if (raw.type === 'assistant') return [reply(raw, message, at)];
  if (raw.type !== 'user' || raw.isMeta === true || raw.isCompactSummary === true) return [];

  const content = message.content;
  const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  if (blocks.some((b) => b.type === 'tool_result')) {
    return blocks.flatMap((b): Entry[] => {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') return [{ kind: 'result', at, toolUseId: b.tool_use_id, failed: b.is_error === true }];
      if (b.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Request interrupted')) return [{ kind: 'interrupted', at }];
      return [];
    });
  }
  const texts = typeof content === 'string' ? [content] : blocks.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean);
  const text = texts.join('\n\n').trim();
  if (!text) return [];
  if (text.startsWith('[Request interrupted')) return [{ kind: 'interrupted', at }];
  if (text.startsWith('<local-command-std')) {
    const output = clip(stripTags(text));
    return output ? [{ kind: 'note', at, text: output }] : [];
  }
  const promptId = typeof raw.promptId === 'string' ? raw.promptId : undefined;
  const origin = raw.origin as Record<string, unknown> | undefined;
  if (text.startsWith('<task-notification>')) {
    return [{ kind: 'prompt', at, promptId, from: 'agent', text: clip(tag(text, 'summary') ?? 'A background task finished') }];
  }
  const command = tag(text, 'command-name');
  const shown = command ? [command, tag(text, 'command-args')].filter(Boolean).join(' ') : clip(stripWrappers(text));
  return shown ? [{ kind: 'prompt', at, promptId, from: origin?.kind === 'task-notification' ? 'agent' : 'you', text: shown }] : [];
}

function reply(raw: Record<string, unknown>, message: Record<string, unknown>, at: string): Entry {
  const steps: Step[] = [];
  for (const block of Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) steps.push({ kind: 'text', text: clip(block.text.trim()) });
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      steps.push({ kind: 'tool', id: typeof block.id === 'string' ? block.id : undefined, name: block.name.slice(0, 80), summary: toolSummary(block.name, block.input) });
    }
  }
  const model = typeof message.model === 'string' && !message.model.startsWith('<') ? message.model : undefined;
  return {
    kind: 'reply',
    at,
    messageId: typeof message.id === 'string' ? message.id : String(raw.uuid ?? at),
    model,
    steps,
    tokens: tokensOf(message.usage),
    stop: typeof message.stop_reason === 'string' ? message.stop_reason : undefined,
    failed: raw.isApiErrorMessage === true,
  };
}

function tokensOf(value: unknown): MessageTokens | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const u = value as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const split = u.cache_creation as Record<string, unknown> | undefined;
  const write1h = n(split?.ephemeral_1h_input_tokens);
  const write5m = split ? n(split.ephemeral_5m_input_tokens) : n(u.cache_creation_input_tokens);
  const servers = u.server_tool_use as Record<string, unknown> | undefined;
  return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite5m: write5m, cacheWrite1h: write1h, webSearches: n(servers?.web_search_requests), fast: u.speed === 'fast' };
}

function toolSummary(name: string, input: unknown): string | undefined {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if ((name === 'Agent' || name === 'Task') && typeof fields.description === 'string') return fields.description.slice(0, 200);
  if (name === 'Skill' && typeof fields.skill === 'string') return fields.skill.slice(0, 200);
  return summarise(name, input);
}

/** Groups entries into turns. A turn starts with each new prompt; Claude Code gives every entry of a turn the same prompt ID. */
export function buildTurns(entries: Entry[], costOf: CostOf): Turn[] {
  interface Draft extends Turn {
    messages: Map<string, { model?: string; tokens?: MessageTokens }>;
    last?: Entry;
    interrupted: boolean;
    failed: boolean;
  }
  const turns: Draft[] = [];
  const tools = new Map<string, Extract<Turn['steps'][number], { kind: 'tool' }>>();
  let turn: Draft | undefined;
  const start = (at: string, from: 'you' | 'agent', id: string | undefined, prompt?: string): Draft => {
    const draft: Draft = { id: id ?? `turn-${turns.length + 1}`, at, endedAt: at, from, prompt, steps: [], state: 'done', own: emptyUsage(), messages: new Map(), interrupted: false, failed: false };
    turns.push(draft);
    return draft;
  };

  for (const e of entries) {
    if (e.kind === 'prompt') {
      if (turn && e.promptId && turn.id === e.promptId) {
        turn.prompt = turn.prompt ? `${turn.prompt}\n\n${e.text}` : e.text;
        turn.endedAt = e.at;
      } else {
        turn = start(e.at, e.from, e.promptId, e.text);
      }
      turn.last = e;
      continue;
    }
    turn ??= start(e.at, 'agent', undefined);
    turn.endedAt = e.at;
    if (e.kind === 'reply') {
      for (const step of e.steps) {
        const copy = { ...step }; // entries are cached, so the turn gets its own copy to mark
        turn.steps.push(copy);
        if (copy.kind === 'tool' && copy.id) tools.set(copy.id, copy);
      }
      const seen = turn.messages.get(e.messageId);
      turn.messages.set(e.messageId, { model: e.model ?? seen?.model, tokens: e.tokens ?? seen?.tokens });
      if (e.model) turn.model = e.model;
      if (e.tokens && (e.tokens.input || e.tokens.cacheRead || e.tokens.cacheWrite5m || e.tokens.cacheWrite1h)) {
        turn.contextTokens = e.tokens.input + e.tokens.cacheRead + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h;
      }
      if (e.failed) turn.failed = true;
      turn.last = e;
    } else if (e.kind === 'result') {
      const tool = tools.get(e.toolUseId);
      if (tool && e.failed) tool.failed = true;
      turn.last = e;
    } else if (e.kind === 'note') {
      turn.steps.push({ kind: 'note', text: e.text });
    } else {
      turn.interrupted = true;
      turn.last = e;
    }
  }

  return turns.map(({ messages, last, interrupted, failed, ...t }, i) => {
    for (const { model, tokens } of messages.values()) if (tokens) addUsage(t.own, priced(model, tokens, costOf));
    const settled = i < turns.length - 1 || (last?.kind === 'reply' && last.stop !== undefined && last.stop !== 'tool_use');
    const state: Turn['state'] = failed ? 'failed' : interrupted ? 'interrupted' : settled ? 'done' : 'running';
    return { ...t, state };
  });
}

function priced(model: string | undefined, t: MessageTokens, costOf: CostOf): UsageTotals {
  const usage = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite5m + t.cacheWrite1h, costUsd: 0 } as UsageTotals;
  const tokens = t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
  if (!tokens) return usage;
  const cost = costOf(model, t);
  if (cost === undefined) usage.unpriced = [`${model ?? 'unknown model'}${t.fast ? ' (fast)' : ''}`];
  else usage.costUsd = cost;
  return usage;
}

export interface Helper extends StoryHelper {
  file: string;
  toolUseId?: string;
  turns: Turn[];
}

/** A session's subagents, from `<session>/subagents/` beside its transcript. */
export function helpersOf(transcript: string, costOf: CostOf): Helper[] {
  const folder = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  return list(folder).filter((f) => /^agent-[\w-]+\.jsonl$/.test(f)).map((f) => helperAt(join(folder, f), costOf));
}

export function helperAt(file: string, costOf: CostOf): Helper {
  const id = basename(file, '.jsonl').replace(/^agent-/, '');
  const meta = readMeta(file.replace(/\.jsonl$/, '.meta.json'));
  const turns = buildTurns(readEntries(file, true), costOf);
  const last = turns.at(-1);
  return {
    id,
    file,
    name: label(meta.agentType),
    description: label(meta.description, 200),
    toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined,
    state: last?.state === 'running' ? 'working' : 'done',
    tools: turns.reduce((n, t) => n + t.steps.filter((s) => s.kind === 'tool').length, 0),
    lastAt: last?.endedAt,
    usage: turns.reduce((u, t) => addUsage(u, t.own), emptyUsage()),
    turns,
  };
}

/** The turns of a main transcript, without helpers attached. */
export const turnsOf = (transcript: string, costOf: CostOf) => buildTurns(readEntries(transcript), costOf);

/** The story of a session, or of one of its helpers, for the panel. `turns` caps how many recent turns come back. */
export function readStory(transcript: string, options: { costOf: CostOf; turns: number; helper?: string }): Story | null {
  const helpers = helpersOf(transcript, options.costOf);
  const helper = options.helper ? helpers.find((h) => h.id === options.helper) : undefined;
  if (options.helper && !helper) return null;
  const turns = helper ? helper.turns : turnsOf(transcript, options.costOf);
  const byTool = new Map(helpers.filter((h) => h.toolUseId).map((h) => [h.toolUseId, h]));

  // Each turn counts its own tokens plus those of the helpers it started.
  const told: StoryTurn[] = turns.map(({ own, model, contextTokens, ...t }) => {
    const usage = addUsage(emptyUsage(), own);
    const steps = t.steps.map((step): StoryStep => {
      if (step.kind !== 'tool') return step;
      const { id, ...tool } = step;
      const h = id ? byTool.get(id) : undefined;
      if (!h) return tool;
      addUsage(usage, h.usage);
      return { ...tool, helper: shownHelper(h) };
    });
    return { ...t, steps, usage };
  });
  // A session's total also counts helpers that no turn names, such as a helper's own helpers.
  const usage = helper
    ? told.reduce((u, t) => addUsage(u, t.usage), emptyUsage())
    : helpers.reduce((u, h) => addUsage(u, h.usage), turns.reduce((u, t) => addUsage(u, t.own), emptyUsage()));

  const keep = Math.max(1, options.turns);
  return {
    sessionId: basename(transcript, '.jsonl'),
    ...(helper ? { helperId: helper.id } : {}),
    model: turns.findLast((t) => t.model)?.model,
    contextTokens: turns.findLast((t) => t.contextTokens !== undefined)?.contextTokens,
    usage: round(usage),
    turns: told.slice(-keep).map((t) => ({ ...t, usage: round(t.usage) })),
    earlier: Math.max(0, told.length - keep),
  };
}

const shownHelper = (h: Helper): StoryHelper => ({ id: h.id, name: h.name, description: h.description, state: h.state, tools: h.tools, lastAt: h.lastAt, usage: round(h.usage) });
const round = (u: UsageTotals): UsageTotals => ({ ...u, costUsd: Math.round(u.costUsd * 1e6) / 1e6 });

// -- Incremental reading: a transcript is re-read only from where the last read stopped --

interface Cached {
  offset: number;
  entries: Entry[];
  used: number;
}

const CACHE_FILES = 24;
const cache = new Map<string, Cached>();

export function readEntries(file: string, sidechain = false): Entry[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  let cached = cache.get(file);
  if (!cached || size < cached.offset) cached = { offset: 0, entries: [], used: 0 };
  if (size > cached.offset) {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - cached.offset);
      const read = readSync(fd, buffer, 0, buffer.length, cached.offset);
      const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1; // only whole lines; the last may still be being written
      if (end > 0) {
        cached.entries.push(...parseLines(buffer.subarray(0, end).toString('utf8'), sidechain));
        cached.offset += end;
      }
    } catch {
      // A transcript being rewritten is read again from the start next time.
    } finally {
      closeSync(fd);
    }
  }
  cached.used = Date.now();
  cache.set(file, cached);
  if (cache.size > CACHE_FILES) {
    const oldest = [...cache].sort((a, b) => a[1].used - b[1].used)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return cached.entries;
}

// -- Helpers --

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readMeta(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readTail(file: string, size: number): string {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

function parse(line: string | undefined): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null; // the first line of a tail is usually cut in half
  }
}

const label = (value: unknown, max = 80) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || undefined;
const stripTags = (text: string) => text.replace(/<\/?[a-z-]+>/g, '').trim();
// Context Claude Code adds around what I typed: editor selections, open files and reminders.
// Pasted text keeps its content and loses its wrapper.
const stripWrappers = (text: string) =>
  text.replace(/<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g, '').replace(/<\/?pasted_content[^>]*>/g, '').trim();
