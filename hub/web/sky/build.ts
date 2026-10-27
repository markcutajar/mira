// Build mode (decisions 39 and 44): how I arrange the island. Plants and decorations go anywhere
// free, on a project's own ground, its shore or the coast and stream banks around it, and boats and
// lily pads go on the water. Ground can be painted as path, grass or flowers. The buildings that
// reflect real work can be moved about their own ground and restyled, but never added or removed.
// No DOM or Phaser here, so it can be tested on its own.

import type { SectionLayout } from '../../src/layout.ts';
import { hash, SEC, sectionOrigin, templateBuildings, type BuildingType, type Cell, type HouseStyle, type Template, type TemplateBuilding } from './world.ts';

export type { SectionLayout };

export type ItemKind =
  | 'tree' | 'tree-apple' | 'pine' | 'shrub' | 'flowerbed' | 'sunflowers' | 'mushrooms'
  | 'lamp' | 'bench' | 'statue' | 'rock' | 'crates' | 'well' | 'campfire'
  | 'lilies' | 'boat';
export type ItemGroup = 'Plants' | 'Decor' | 'Water';
export const ITEMS: Record<ItemKind, { label: string; group: ItemGroup }> = {
  tree: { label: 'Oak tree', group: 'Plants' },
  'tree-apple': { label: 'Apple tree', group: 'Plants' },
  pine: { label: 'Pine tree', group: 'Plants' },
  shrub: { label: 'Shrub', group: 'Plants' },
  flowerbed: { label: 'Flower bed', group: 'Plants' },
  sunflowers: { label: 'Sunflowers', group: 'Plants' },
  mushrooms: { label: 'Mushrooms', group: 'Plants' },
  lamp: { label: 'Lamp', group: 'Decor' },
  bench: { label: 'Bench', group: 'Decor' },
  statue: { label: 'Statue', group: 'Decor' },
  rock: { label: 'Rock', group: 'Decor' },
  crates: { label: 'Crates', group: 'Decor' },
  well: { label: 'Well', group: 'Decor' },
  campfire: { label: 'Campfire', group: 'Decor' },
  lilies: { label: 'Lily pads', group: 'Water' },
  boat: { label: 'Rowing boat', group: 'Water' },
};
export const isItem = (kind: string): kind is ItemKind => kind in ITEMS;
export const onWater = (kind: ItemKind) => ITEMS[kind].group === 'Water';

export type Ground = 'path' | 'grass' | 'flowers';
const GROUND: Record<Ground, 'p' | 'g' | 'f'> = { path: 'p', grass: 'g', flowers: 'f' };
export type Tool = ItemKind | Ground | 'move' | 'restyle' | 'remove';
export const HOUSE_STYLES: HouseStyle[] = ['brick', 'timber', 'stone'];
const LETTER: Record<BuildingType, string> = { house: 'H', library: 'L', workshop: 'W' };
export const BUILDING_LABEL: Record<BuildingType, string> = { house: 'house', library: 'library', workshop: 'workshop' };

/** How far past its shore a section's layout reaches: the coast and stream banks around it. */
const REACH = 3;
/** Land a layout can paint or decorate: grass, path and flowers, never a bridge. */
const LAND = 'gpf';

/** A building where it stands after my moves, with its style. */
export interface Placed extends TemplateBuilding {
  style: HouseStyle;
}

/** Where a tile is in a layout: whose section, the place counted from its corner, and whether that's its own ground. */
export interface Where {
  i: number;
  place: string;
  own: boolean;
}

/**
 * The section whose layout a tile belongs to, and its place there: its own ground inside its shore,
 * or else the nearest section within reach, the first one on a tie. `by` names the section that
 * already arranged the tile, so changing it again goes back to that layout. Null beyond every reach.
 */
export function placeOf(c: number, r: number, sections: number, by?: number): Where | null {
  let best: Where | null = null;
  let nearest = Infinity;
  for (let i = 0; i < sections; i++) {
    const { c0, r0 } = sectionOrigin(i);
    const lc = c - c0;
    const lr = r - r0;
    if (lc >= 1 && lc <= SEC - 2 && lr >= 1 && lr <= SEC - 2) return { i, place: `${lc},${lr}`, own: true };
    const d = Math.max(-lc, lc - (SEC - 1), -lr, lr - (SEC - 1), 0);
    if (d > REACH) continue;
    const here = { i, place: `${lc},${lr}`, own: false };
    if (i === by) return here;
    if (d < nearest) [best, nearest] = [here, d];
  }
  return best;
}

/** Lays a section's layout over the island's tiles, and returns its buildings where they now stand. */
export function arrange(cells: Map<string, Cell>, i: number, template: Template, layout?: SectionLayout): Placed[] {
  const { c0, r0 } = sectionOrigin(i);
  // Each tile a layout changes remembers whose it was, so build mode changes it there again.
  const at = (place: string) => {
    const [lc, lr] = place.split(',').map(Number);
    return cells.get(`${c0 + (lc ?? 0)},${r0 + (lr ?? 0)}`);
  };
  const mark = (cell: Cell) => Object.assign(cell, { by: i });
  // A house keeps the style its template place gave it, wherever it's moved, until I choose another.
  const buildings: Placed[] = templateBuildings(i, template).map((b, k) => ({
    ...b,
    style: layout?.styles?.[k] ?? (HOUSE_STYLES[Math.floor(hash(b.c, b.r, 5) * HOUSE_STYLES.length)] as HouseStyle),
  }));
  if (!layout) return buildings;
  for (const place of layout.removed ?? []) {
    const cell = at(place);
    if (cell?.ch === 'T') Object.assign(mark(cell), { ch: 'g', walk: true });
  }
  // Moved buildings leave their places first, so one can take another's old place.
  const moving = buildings.filter((_, k) => layout.moved?.[k]);
  for (const b of moving) Object.assign(cells.get(`${b.c},${b.r}`) ?? {}, { ch: 'g', walk: true });
  for (const b of moving) {
    const [lc, lr] = layout.moved?.[buildings.indexOf(b)] ?? [0, 0];
    const to = cells.get(`${c0 + lc},${r0 + lr}`);
    const target = to?.walk ? to : cells.get(`${b.c},${b.r}`); // its new place is taken: it stays put
    if (!target) continue;
    Object.assign(target, { ch: LETTER[b.type], walk: false });
    Object.assign(b, { c: target.c, r: target.r });
  }
  for (const [place, ch] of Object.entries(layout.ground ?? {})) {
    const cell = at(place);
    if (cell?.walk && !cell.item && LAND.includes(cell.ch)) mark(cell).ch = ch;
  }
  for (const [place, kind] of Object.entries(layout.placed ?? {})) {
    const cell = at(place);
    if (!cell || cell.item || !isItem(kind)) continue;
    if (onWater(kind) ? cell.ch === 'w' : cell.walk && LAND.includes(cell.ch)) Object.assign(mark(cell), { item: kind, walk: false });
  }
  return buildings;
}

/** True when two sets of layouts say the same, whatever order their keys came in. */
export function sameLayouts(a: Record<string, SectionLayout>, b: Record<string, SectionLayout>): boolean {
  const canon = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, canon(v)]))
      : value;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export type Outcome = { layout: SectionLayout } | { refused: string };

/** What a tool does to a free or decorated tile, or why it can't. */
export function edit(layout: SectionLayout | undefined, tool: Exclude<Tool, 'move' | 'restyle'>, cell: Cell, place: string): Outcome {
  const next: SectionLayout = structuredClone(layout ?? {});
  if (tool === 'remove') {
    if (next.placed?.[place]) {
      delete next.placed[place];
      return { layout: next };
    }
    if (cell.ch === 'T') {
      next.removed = [...(next.removed ?? []), place];
      return { layout: next };
    }
    return { refused: 'Nothing to remove here. Buildings stay: move them instead.' };
  }
  if (cell.ch === 'b') return { refused: 'Bridges stay, so the projects stay joined.' };
  if (cell.item) return { refused: 'Something is already here. Remove it first.' };
  if (isItem(tool) && onWater(tool)) {
    if (cell.ch !== 'w') return { refused: tool === 'boat' ? 'A boat goes on the water.' : 'Lily pads go on the water.' };
    return { layout: { ...next, placed: { ...next.placed, [place]: tool } } };
  }
  if (cell.ch === 'w') return { refused: "That's water: lily pads and boats go there." };
  if (!cell.walk || !LAND.includes(cell.ch)) return { refused: 'That tile is taken.' };
  if (isItem(tool)) return { layout: { ...next, placed: { ...next.placed, [place]: tool } } };
  if (cell.ch === GROUND[tool]) return { refused: `It's ${tool} already.` };
  return { layout: { ...next, ground: { ...next.ground, [place]: GROUND[tool] } } };
}

/** Moves a building to a free tile of its own section's ground. */
export function move(layout: SectionLayout | undefined, building: number, to: Cell, where: Where): Outcome {
  if (!where.own) return { refused: "A building stays on its project's own ground, inside the shore." };
  if (!to.walk || !LAND.includes(to.ch)) return { refused: 'That tile is taken. Pick a free one.' };
  const [lc, lr] = where.place.split(',').map(Number) as [number, number];
  return { layout: { ...structuredClone(layout ?? {}), moved: { ...layout?.moved, [building]: [lc, lr] } } };
}

/** Gives a house the next style along. */
export function restyle(layout: SectionLayout | undefined, building: number, current: HouseStyle): Outcome {
  const style = HOUSE_STYLES[(HOUSE_STYLES.indexOf(current) + 1) % HOUSE_STYLES.length] as HouseStyle;
  return { layout: { ...structuredClone(layout ?? {}), styles: { ...layout?.styles, [building]: style } } };
}
