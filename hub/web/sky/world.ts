// The island's layout: one hedged section per project, placed in the order the projects first
// appeared, so a new project adds a section at the edge and nothing already there moves.
// No DOM or Phaser here, so it can be tested on its own.

export const SEC = 10; // a section is 10 × 10 tiles, including its hedge ring
const GAP = 2;
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
  /** g grass, p path, f flowers, w water, h hedge, T tree, or a building letter. */
  ch: string;
  section: number | null;
  walk: boolean;
  /** A plant or decoration placed in build mode (decision 39). */
  item?: string;
}

export interface TemplateBuilding extends Spot {
  id: string;
  type: BuildingType;
}

export const AROUND: Array<[number, number]> = [[0, 1], [1, 0], [1, 1], [-1, 1], [1, -1], [0, -1], [-1, 0], [-1, -1]];
const BUILDING_AT: Record<string, BuildingType> = { H: 'house', L: 'library', W: 'workshop' };

// The inside of a section, 8 × 8 tiles inside its hedge.
export const TEMPLATES: Record<Template, string[]> = {
  code: [
    'gHgpgHgT',
    'ggppppgg',
    'gLpggpWg',
    'gpgfgpgg',
    'Hpgwwpgf',
    'gpgwwpHg',
    'gpppppgg',
    'TgHgfggT',
  ],
};

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

/** The island's tiles for these sections: hedge rings with gates, paths between, a ragged coast outside. */
export function generateCells(templates: Template[]): Map<string, Cell> {
  const secs = templates.map((template, i) => ({ i, template, ...sectionOrigin(i) }));
  const cells = new Map<string, Cell>();
  if (!secs.length) return cells;
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
      let ch = 'g';
      if (sec) {
        const lc = c - sec.c0;
        const lr = r - sec.r0;
        if (lc === 0 || lr === 0 || lc === SEC - 1 || lr === SEC - 1) {
          const gate = ((lr === 0 || lr === SEC - 1) && (lc === 4 || lc === 5)) || ((lc === 0 || lc === SEC - 1) && (lr === 4 || lr === 5));
          ch = gate ? 'p' : 'h';
        } else {
          ch = TEMPLATES[sec.template][lr - 1]?.[lc - 1] ?? 'g';
        }
      } else if (d === 0) {
        ch = 'p';
      } else {
        const roll = hash(c, r, 2);
        ch = roll < 0.09 ? 'T' : roll < 0.2 ? 'f' : 'g';
      }
      cells.set(`${c},${r}`, { c, r, ch, section: sec ? sec.i : null, walk: 'gpf'.includes(ch) });
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
