// The island's layout: one section per project, placed in the order the projects first appeared,
// so a new project adds a section at the edge and nothing already there moves. Streams run between
// neighbouring sections, out to the coast, with a bridge where each pair meets (decision 42).
// No DOM or Phaser here, so it can be tested on its own.

export const SEC = 10; // a section is 10 × 10 tiles: 8 × 8 of its own ground inside a ring of shore
const GAP = 2; // the stream between neighbouring sections
const MARGIN = 3;
const PITCH = SEC + GAP;

export type Template = 'code';
export type BuildingType = 'house' | 'library' | 'workshop';
export type HouseStyle = 'brick' | 'timber' | 'stone';

export interface Spot {
  c: number;
  r: number;
}

export interface Cell extends Spot {
  /** g grass, p path, f flowers, w water, b bridge, T tree, S swings, D slide, or a building letter. */
  ch: string;
  section: number | null;
  walk: boolean;
  /** Which way a bridge crosses its stream: along columns or along rows. */
  span?: 'c' | 'r';
  /** A plant or decoration placed in build mode (decision 39). */
  item?: string;
}

export interface TemplateBuilding extends Spot {
  id: string;
  type: BuildingType;
}

export const AROUND: Array<[number, number]> = [[0, 1], [1, 0], [1, 1], [-1, 1], [1, -1], [0, -1], [-1, 0], [-1, -1]];
const BUILDING_AT: Record<string, BuildingType> = { H: 'house', L: 'library', W: 'workshop' };

// The inside of a section, 8 × 8 tiles inside its shore, with a pond and a playground where
// mirlings wait for me (decision 41). Buildings keep their places and order, which layouts refer to.
export const TEMPLATES: Record<Template, string[]> = {
  code: [
    'gHgpgHgT',
    'ggppppgg',
    'gLpggpWg',
    'gpgfgpgS',
    'Hpwwwpgf',
    'gpwwwpHD',
    'gpppppgg',
    'TgHgfggT',
  ],
};
const WALK = 'gpfb';

/** A repeatable pseudo-random number in [0, 1) for a tile, so the island looks the same every time. */
export function hash(c: number, r: number, salt: number): number {
  let h = (Math.imul(c + 101, 374761393) + Math.imul(r + 211, 668265263) + Math.imul(salt + 7, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Where section `i` sits on a growing square of slots: 1 × 1, then 2 × 2, then 3 × 3, each new
 * ring added along the far edges. Slot positions never change as the square grows.
 */
export function slot(i: number): [number, number] {
  let ring = 0;
  while ((ring + 1) * (ring + 1) <= i) ring += 1;
  const k = i - ring * ring;
  return k < ring ? [ring, k] : [k - ring, ring];
}

export function sectionOrigin(i: number): { c0: number; r0: number } {
  const [sx, sy] = slot(i);
  return { c0: MARGIN + sx * PITCH, r0: MARGIN + sy * PITCH };
}

/**
 * Where streams run: the gap between every pair of neighbouring slot columns and rows, the whole way
 * across the island, so each flows out to the coast. Each is two tiles wide, and a tile wider on one
 * bank or the other in places, never beside a gate. Returns a bridge's direction for a bridge tile,
 * true for water and false for land.
 */
function streams(slots: Array<[number, number]>) {
  const taken = new Set(slots.map(([x, y]) => `${x},${y}`));
  const last = [Math.max(...slots.map((s) => s[0])), Math.max(...slots.map((s) => s[1]))] as const;
  // The stream a coordinate falls in, or -1; and the stream a bank tile lies beside, with which side.
  const band = (v: number, n: number) => {
    const k = Math.floor((v - MARGIN - SEC) / PITCH);
    return k >= 0 && k < n && v - MARGIN - SEC - k * PITCH < GAP ? k : -1;
  };
  const bank = (v: number, n: number): { k: number; side: -1 | 1 } | null => {
    if (band(v, n) >= 0) return null;
    for (const side of [-1, 1] as const) {
      const k = band(v - side, n);
      if (k >= 0) return { k, side };
    }
    return null;
  };
  const gate = (v: number) => {
    const local = (v - MARGIN) % PITCH;
    return local === 4 || local === 5;
  };
  const slotOf = (v: number) => Math.floor((v - MARGIN) / PITCH);
  // Runs of three tiles along a stream where it reaches one tile further into one bank.
  const wider = (k: number, along: number, salt: number) => {
    const run = Math.floor((along + Math.floor(hash(k, salt, 9) * 3)) / 3);
    const roll = hash(k * 7 + salt, run, 11);
    return roll < 0.3 ? -1 : roll > 0.7 ? 1 : 0;
  };
  return (c: number, r: number): 'c' | 'r' | boolean => {
    const kc = band(c, last[0]);
    const kr = band(r, last[1]);
    // A bridge where two sections face each other across a stream: at their gates, two tiles wide.
    if (kc >= 0 && kr < 0 && gate(r) && taken.has(`${kc},${slotOf(r)}`) && taken.has(`${kc + 1},${slotOf(r)}`)) return 'c';
    if (kr >= 0 && kc < 0 && gate(c) && taken.has(`${slotOf(c)},${kr}`) && taken.has(`${slotOf(c)},${kr + 1}`)) return 'r';
    if (kc >= 0 || kr >= 0) return true;
    const bc = bank(c, last[0]);
    if (bc && !gate(r) && wider(bc.k, r, 1) === bc.side) return true;
    const br = bank(r, last[1]);
    return Boolean(br && !gate(c) && wider(br.k, c, 2) === br.side);
  };
}

/** The island's tiles for these sections: open shores with gates, streams and bridges between, a ragged coast outside. */
export function generateCells(templates: Template[]): Map<string, Cell> {
  const secs = templates.map((template, i) => ({ i, template, ...sectionOrigin(i) }));
  const cells = new Map<string, Cell>();
  if (!secs.length) return cells;
  const water = streams(templates.map((_, i) => slot(i)));
  const maxC = Math.max(...secs.map((s) => s.c0)) + SEC + MARGIN + 1;
  const maxR = Math.max(...secs.map((s) => s.r0)) + SEC + MARGIN + 1;
  for (let r = 0; r <= maxR; r++) {
    for (let c = 0; c <= maxC; c++) {
      let d = Infinity;
      for (const s of secs) {
        const dx = Math.max(s.c0 - 1 - c, 0, c - (s.c0 + SEC));
        const dy = Math.max(s.r0 - 1 - r, 0, r - (s.r0 + SEC));
        d = Math.min(d, Math.max(dx, dy) + 0.5 * Math.min(dx, dy));
      }
      if (d > MARGIN || (d > MARGIN - 1 && hash(c, r, 1) < 0.5)) continue;
      const sec = secs.find((s) => c >= s.c0 && c < s.c0 + SEC && r >= s.r0 && r < s.r0 + SEC);
      const lc = sec ? c - sec.c0 : -1;
      const lr = sec ? r - sec.r0 : -1;
      const inside = sec && lc > 0 && lr > 0 && lc < SEC - 1 && lr < SEC - 1;
      const stream = inside ? false : water(c, r);
      let ch = 'g';
      let span: 'c' | 'r' | undefined;
      if (inside) {
        ch = TEMPLATES[sec.template][lr - 1]?.[lc - 1] ?? 'g';
      } else if (typeof stream === 'string') {
        ch = 'b';
        span = stream;
      } else if (stream) {
        ch = 'w';
      } else if (sec) {
        // The shore: open, with flowers here and there, and a gate in the middle of every side.
        const gate = ((lr === 0 || lr === SEC - 1) && (lc === 4 || lc === 5)) || ((lc === 0 || lc === SEC - 1) && (lr === 4 || lr === 5));
        ch = gate ? 'p' : hash(c, r, 6) < 0.14 ? 'f' : 'g';
      } else {
        const roll = hash(c, r, 2);
        ch = roll < 0.09 ? 'T' : roll < 0.2 ? 'f' : 'g';
      }
      cells.set(`${c},${r}`, { c, r, ch, section: sec ? sec.i : null, walk: WALK.includes(ch), ...(span ? { span } : {}) });
    }
  }
  return cells;
}

/** The buildings a section's template places, in reading order. */
export function templateBuildings(i: number, template: Template): TemplateBuilding[] {
  const { c0, r0 } = sectionOrigin(i);
  const out: TemplateBuilding[] = [];
  TEMPLATES[template].forEach((row, lr) => [...row].forEach((ch, lc) => {
    const type = BUILDING_AT[ch];
    if (type) out.push({ id: `${i}:${out.length}`, type, c: c0 + 1 + lc, r: r0 + 1 + lr });
  }));
  return out;
}

/** The walkable tiles around a building, where a mirling stands to work at it or enter it. */
export function spotsAround(b: Spot, walkable: (c: number, r: number) => boolean): Spot[] {
  return AROUND.map(([dc, dr]) => ({ c: b.c + dc, r: b.r + dr })).filter((s) => walkable(s.c, s.r));
}

/** The shortest walk between two tiles, not cutting corners past obstacles; empty when there's none. */
export function findPath(walkable: (c: number, r: number) => boolean, from: Spot, to: Spot): Spot[] {
  const key = (c: number, r: number) => r * 4096 + c;
  const prev = new Map<number, Spot | null>([[key(from.c, from.r), null]]);
  const queue: Spot[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as Spot;
    if (cur.c === to.c && cur.r === to.r) break;
    for (const [dc, dr] of AROUND) {
      const n = { c: cur.c + dc, r: cur.r + dr };
      if (!walkable(n.c, n.r) || prev.has(key(n.c, n.r))) continue;
      if (dc && dr && (!walkable(cur.c + dc, cur.r) || !walkable(cur.c, cur.r + dr))) continue;
      prev.set(key(n.c, n.r), cur);
      queue.push(n);
    }
  }
  const path: Spot[] = [];
  if (!prev.has(key(to.c, to.r))) return path;
  for (let n: Spot | null | undefined = to; n && !(n.c === from.c && n.r === from.r); n = prev.get(key(n.c, n.r))) path.unshift({ c: n.c, r: n.r });
  return path;
}
