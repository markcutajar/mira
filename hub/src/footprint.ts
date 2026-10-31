// What Mira costs the machine it runs on (decision 61): each of its processes measures its own CPU
// and memory, and Settings adds them up. Small, so the terminal host can use it too.

import { availableParallelism } from 'node:os';
import type { FootprintReport, Usage } from './footprint-report.ts';

export type { FootprintReport, Usage };

// Two pages asking at once share a reading, rather than one of them measuring a sliver of time.
const MIN_MS = 500;

/** Measures this process: each call says how much CPU it used since the last, and its memory now. */
export function usageMeter(): () => Usage {
  const cores = availableParallelism();
  let at = performance.now();
  let used = process.cpuUsage();
  let last: Usage = { cpu: 0, memory: process.memoryUsage.rss() };
  return () => {
    const now = performance.now();
    if (now - at < MIN_MS) return last;
    const spent = process.cpuUsage(used);
    last = { cpu: (spent.user + spent.system) / 1000 / (now - at) / cores, memory: process.memoryUsage.rss() };
    at = now;
    used = process.cpuUsage();
    return last;
  };
}
