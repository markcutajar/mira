// How far along each landmark is (decision 68), from the per-turn token counts, which the hub keeps
// for good (decision 23): how long ago the first turn was counted, and how many turns there have been.
// Nothing new is kept, and a landmark once earned stays earned.

import { LANDMARKS, type Landmark, type Unlocks } from '../web/shared/landmarks.ts';

export interface TurnTally {
  /** When the first turn was counted, or null before any. */
  first: string | null;
  turns: number;
  /** When the nth turn was counted, from the first, or null if there haven't been that many. */
  nthAt(n: number): string | null;
}

const DAY_MS = 86_400_000;

export function unlocksFrom(tally: TurnTally, now: Date): Unlocks {
  const days = tally.first ? Math.floor((now.getTime() - Date.parse(tally.first)) / DAY_MS) : 0;
  const progress = {} as Unlocks;
  for (const kind of Object.keys(LANDMARKS) as Landmark[]) {
    const { days: needDays, turns: needTurns = 0 } = LANDMARKS[kind];
    if (needDays !== undefined) {
      const at = tally.first && days >= needDays ? new Date(Date.parse(tally.first) + needDays * DAY_MS).toISOString() : null;
      progress[kind] = { at, have: Math.min(days, needDays), need: needDays };
    } else {
      progress[kind] = { at: tally.turns >= needTurns ? tally.nthAt(needTurns) : null, have: Math.min(tally.turns, needTurns), need: needTurns };
    }
  }
  return progress;
}
