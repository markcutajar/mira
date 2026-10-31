// What Settings shows of what Mira costs the machine (decision 61). No imports, so the page can use
// these types too.

/** A process's share of the whole machine's CPU, 0 to 1, as Task Manager counts it, and its memory in bytes. */
export interface Usage {
  cpu: number;
  memory: number;
}

/** The hub and the terminal host, as the hub reports them; the page and the app measure themselves. */
export interface FootprintReport {
  hub: Usage;
  /** Null while no terminal host runs; without `usage` while one runs that started before Mira could measure it. */
  terminals: { running: number; usage?: Usage } | null;
}

/** The app's own processes, grouped: its window's page, the pop-up's, drawing on the graphics card, and the app itself. */
export type AppPart = 'window' | 'popup' | 'graphics' | 'app';
export type AppUsage = Array<Usage & { part: AppPart }>;
