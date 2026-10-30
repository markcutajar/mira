// Two sessions editing the same file (decision 58). A source notes the files its sessions edit, the
// path only and in memory, for an hour; the hub matches them across every live session it shows,
// whichever source each comes from. Paths are compared whole, so two worktrees of a repo never clash.

import { resolve } from 'node:path';
import type { Edit } from './sources.ts';

export type { Edit };

/** How long an edit counts towards a clash. */
export const CLASH_MS = 60 * 60 * 1000;
const MOST_EDITS = 2000;

/** A file this session and another have both edited lately, and that other session. */
export interface Clash {
  file: string;
  with: string;
}

/** The same file however it's written: on Windows, either slash and any case. */
export const fileKey = (file: string) => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));

/** The files each session edited lately, newest last, kept in memory only. */
export class Edits {
  #by = new Map<string, Edit>();

  note(session: string, file: string, at = Date.now()): void {
    const key = `${session}\n${fileKey(file)}`;
    this.#by.delete(key);
    this.#by.set(key, { session, file, at });
    if (this.#by.size > MOST_EDITS) this.#by.delete(this.#by.keys().next().value as string);
  }

  forget(session: string): void {
    for (const [key, edit] of this.#by) if (edit.session === session) this.#by.delete(key);
  }

  /** Edits made since `ms`; older ones are let go. */
  since(ms: number): Edit[] {
    const recent: Edit[] = [];
    for (const [key, edit] of this.#by) {
      if (edit.at < ms) this.#by.delete(key);
      else recent.push(edit);
    }
    return recent;
  }
}

/** Every live session that edited a file another live session edited too, with that file and who else. */
export function findClashes(edits: Edit[], live: Set<string>): Map<string, Clash[]> {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    if (!live.has(edit.session)) continue;
    const key = fileKey(edit.file);
    byFile.set(key, [...(byFile.get(key) ?? []), edit]);
  }
  const found = new Map<string, Clash[]>();
  for (const same of byFile.values()) {
    for (const edit of same) {
      for (const other of same) {
        if (other.session !== edit.session) found.set(edit.session, [...(found.get(edit.session) ?? []), { file: edit.file, with: other.session }]);
      }
    }
  }
  return found;
}
