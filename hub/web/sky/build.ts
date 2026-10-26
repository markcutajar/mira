// Build mode (decision 39): how I arrange each project's section of the island. Plants and
// decorations go anywhere free on its own ground, ground can be painted as path or grass, and the
// buildings that reflect real work can be moved and restyled but never added or removed. No DOM
// or Phaser here, so it can be tested on its own.

import type { SectionLayout } from '../../src/layout.ts';
import { hash, SEC, sectionOrigin, templateBuildings, type BuildingType, type Cell, type HouseStyle, type Template, type TemplateBuilding } from './world.ts';

export type { SectionLayout };

export type ItemKind = 'tree' | 'tree-apple' | 'shrub' | 'flowerbed' | 'lamp' | 'bench' | 'statue';
export const ITEMS: Record<ItemKind, { label: string; group: 'Plants' | 'Decor' }> = {
  tree: { label: 'Oak tree', group: 'Plants' },
  'tree-apple': { label: 'Apple tree', group: 'Plants' },
  shrub: { label: 'Shrub', group: 'Plants' },
  flowerbed: { label: 'Flower bed', group: 'Plants' },
  lamp: { label: 'Lamp', group: 'Decor' },
  bench: { label: 'Bench', group: 'Decor' },
  statue: { label: 'Statue', group: 'Decor' },
};
export const isItem = (kind: string): kind is ItemKind => kind in ITEMS;

export type Tool = ItemKind | 'path' | 'grass' | 'move' | 'restyle' | 'remove';
export const HOUSE_STYLES: HouseStyle[] = ['brick', 'timber', 'stone'];
const LETTER: Record<BuildingType, string> = { house: 'H', library: 'L', workshop: 'W' };
export const BUILDING_LABEL: Record<BuildingType, string> = { house: 'house', library: 'library', workshop: 'workshop' };

/** A building where it stands after my moves, with its style. */
export interface Placed extends TemplateBuilding {
  style: HouseStyle;
}

/** Where a tile lies on a section's own ground, inside its shore, as the layout names it; null anywhere else. */
export function placeOf(c: number, r: number, sections: number): { i: number; place: string } | null {
  for (let i = 0; i < sections; i++) {
    const { c0, r0 } = sectionOrigin(i);
    const lc = c - c0;
    const lr = r - r0;
    if (lc >= 1 && lc <= SEC - 2 && lr >= 1 && lr <= SEC - 2) return { i, place: `${lc},${lr}` };
  }
  return null;
}

/** Lays a section's layout over the island's tiles, and returns its buildings where they now stand. */
export function arrange(cells: Map<string, Cell>, i: number, template: Template, layout?: SectionLayout): Placed[] {
  const { c0, r0 } = sectionOrigin(i);
  const at = (place: string) => {
    const [lc, lr] = place.split(',').map(Number);
    return cells.get(`${c0 + (lc ?? 0)},${r0 + (lr ?? 0)}`);
  };
  // A house keeps the style its template place gave it, wherever it's moved, until I choose another.
  const buildings: Placed[] = templateBuildings(i, template).map((b, k) => ({
    ...b,
    style: layout?.styles?.[k] ?? (HOUSE_STYLES[Math.floor(hash(b.c, b.r, 5) * HOUSE_STYLES.length)] as HouseStyle),
  }));
  if (!layout) return buildings;
  for (const place of layout.removed ?? []) {
    const cell = at(place);
    if (cell?.ch === 'T') Object.assign(cell, { ch: 'g', walk: true });
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
    if (cell?.walk) cell.ch = ch;
  }
  for (const [place, kind] of Object.entries(layout.placed ?? {})) {
    const cell = at(place);
    if (cell?.walk && isItem(kind)) Object.assign(cell, { item: kind, walk: false });
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
  if (!cell.walk) return { refused: cell.item ? 'Something is already here. Remove it first.' : 'That tile is taken.' };
  if (tool === 'path' || tool === 'grass') {
    const ch = tool === 'path' ? 'p' : 'g';
    if (cell.ch === ch) return { refused: `It's ${tool} already.` };
    next.ground = { ...next.ground, [place]: ch };
  } else {
    next.placed = { ...next.placed, [place]: tool };
  }
  return { layout: next };
}

/** Moves a building to a free tile of its own section. */
export function move(layout: SectionLayout | undefined, building: number, to: Cell, place: string): Outcome {
  if (!to.walk) return { refused: 'That tile is taken. Pick a free one.' };
  const [lc, lr] = place.split(',').map(Number) as [number, number];
  return { layout: { ...structuredClone(layout ?? {}), moved: { ...layout?.moved, [building]: [lc, lr] } } };
}

/** Gives a house the next style along. */
export function restyle(layout: SectionLayout | undefined, building: number, current: HouseStyle): Outcome {
  const style = HOUSE_STYLES[(HOUSE_STYLES.indexOf(current) + 1) % HOUSE_STYLES.length] as HouseStyle;
  return { layout: { ...structuredClone(layout ?? {}), styles: { ...layout?.styles, [building]: style } } };
}
