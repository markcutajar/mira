// The one module that reads Claude Code transcripts (decision 5). Their format is internal to
// Claude Code and changes between releases, so every read is defensive: anything unexpected is
// skipped, never thrown. Only metadata is read here: session, folder, time and turn state.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Status } from '../../../contracts/src/index.ts';

export interface TranscriptSession {
  sessionId: string;
  cwd: string;
  lastAt: string;
  status: Status;
  transcript: string;
}

const TAIL_BYTES = 256 * 1024;

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

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
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
