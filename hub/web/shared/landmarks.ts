// Landmarks (decision 68): build pieces the island earns with time and work. The hub says how far
// along each one is, and the page lets me build those that are unlocked. No imports, so the hub
// uses it too.

export type Landmark = 'windmill' | 'fountain' | 'observatory' | 'lighthouse' | 'balloon';

/** What each landmark takes: days since Mira counted its first turn, or turns finished in all. */
export const LANDMARKS: Record<Landmark, { label: string; days?: number; turns?: number; need: string }> = {
  windmill: { label: 'Windmill', days: 7, need: 'a week with Mira' },
  fountain: { label: 'Fountain', turns: 100, need: '100 turns finished' },
  observatory: { label: 'Observatory', days: 30, need: 'a month with Mira' },
  lighthouse: { label: 'Lighthouse', turns: 1000, need: '1,000 turns finished' },
  balloon: { label: 'Hot-air balloon', turns: 10000, need: '10,000 turns finished' },
};

/** How far along a landmark is: `at` is when it was earned, or null while it's still to come. */
export interface Progress {
  at: string | null;
  have: number;
  need: number;
}

export type Unlocks = Record<Landmark, Progress>;
