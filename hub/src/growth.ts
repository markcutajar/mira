// How much each project has turned out lately (decision 35): commits in its git history over the
// last 30 days, and how many of them changed docs. The history is read on demand, the same way
// transcripts are, and only the counts are kept, in memory.

import { execFile } from 'node:child_process';

export interface Growth {
  commits: number;
  /** Commits that changed docs: Markdown, a docs folder or a README. */
  docs: number;
  /** Building levels, 1 to 5: the workshop from commits, the library from docs. */
  workshop: number;
  library: number;
}

export const GROWTH_DAYS = 30;
const WORKSHOP_STEPS = [5, 15, 40, 100]; // commits to reach levels 2 to 5
const LIBRARY_STEPS = [2, 6, 15, 40];
const DOC = /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|adoc)$|(^|\/)readme/i;

export const levelFor = (count: number, steps: number[]) => 1 + steps.filter((step) => count >= step).length;

/** Counts the commits in `git log --name-only --format=%x1e` output, and those that touched docs. */
export function countCommits(log: string): { commits: number; docs: number } {
  const commits = log.split('\x1e').slice(1);
  return { commits: commits.length, docs: commits.filter((files) => files.split('\n').some((f) => DOC.test(f.trim()))).length };
}

/** A repo's recent history; empty for a folder that isn't a repo, or if git isn't there. */
export function gitLog(root: string): Promise<string> {
  // fsmonitor is switched off so reading a repo never starts a program its config names.
  const args = ['-C', root, '-c', 'core.fsmonitor=false', 'log', `--since=${GROWTH_DAYS}.days`, '--no-merges', '--name-only', '--format=%x1e'];
  return new Promise((done) => {
    execFile('git', args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => done(err ? '' : stdout));
  });
}

export interface GrowthOptions {
  /** The projects to keep counts for. */
  systems(): string[];
  /** The repo roots a project's sessions have worked in. */
  rootsFor(system: string): string[];
  /** Called when any project's counts change. */
  onChange(): void;
  read?: (root: string) => Promise<string>;
}

export class GrowthTracker {
  #options: GrowthOptions;
  #by = new Map<string, Growth>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(options: GrowthOptions) {
    this.#options = options;
  }

  get(system: string): Growth | undefined {
    return this.#by.get(system);
  }

  /** Reads every project's history again, and reports if anything changed. */
  async refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    const read = this.#options.read ?? gitLog;
    let changed = false;
    try {
      for (const system of this.#options.systems()) {
        let commits = 0;
        let docs = 0;
        for (const root of this.#options.rootsFor(system)) {
          const counted = countCommits(await read(root));
          commits += counted.commits;
          docs += counted.docs;
        }
        const next: Growth = { commits, docs, workshop: levelFor(commits, WORKSHOP_STEPS), library: levelFor(docs, LIBRARY_STEPS) };
        const last = this.#by.get(system);
        if (last?.commits === next.commits && last.docs === next.docs) continue;
        this.#by.set(system, next);
        changed = true;
      }
    } finally {
      this.#running = false;
    }
    if (changed) this.#options.onChange();
  }

  /** Reads again shortly, for after a turn ends, when a commit is likely. Repeated calls wait for the last. */
  refreshSoon(delayMs = 15_000): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; void this.refresh(); }, delayMs);
    this.#timer.unref();
  }

  start(everyMs: number): void {
    void this.refresh();
    setInterval(() => void this.refresh(), everyMs).unref();
  }
}
