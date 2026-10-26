// Build mode's layouts (decision 39): how I arranged each project's section of the island, kept by
// the hub so every browser shows the same island. Places are on the section's own ground, 1 to 8
// across and down, so a layout follows its section wherever the island puts it.

import { z } from 'zod';

const Place = z.string().regex(/^[1-8],[1-8]$/);
/** A building, by its place in its template's order. */
const Building = z.string().regex(/^\d{1,2}$/);
const Coordinate = z.number().int().min(1).max(8);

export const SectionLayout = z.strictObject({
  /** Ground painted as path or grass. */
  ground: z.record(Place, z.enum(['p', 'g'])).optional(),
  /** Plants and decorations, by kind; the page ignores kinds it doesn't know. */
  placed: z.record(Place, z.string().regex(/^[a-z][a-z-]{0,23}$/)).optional(),
  /** Trees the template planted that I took away. */
  removed: z.array(Place).max(64).optional(),
  /** Buildings moved to another place in their section. */
  moved: z.record(Building, z.tuple([Coordinate, Coordinate])).optional(),
  /** House styles chosen. */
  styles: z.record(Building, z.enum(['brick', 'timber', 'stone'])).optional(),
});
export type SectionLayout = z.infer<typeof SectionLayout>;

/** True when a layout changes nothing, so there's nothing to keep. */
export const emptyLayout = (layout: SectionLayout) =>
  Object.values(layout).every((part) => !part || (Array.isArray(part) ? !part.length : !Object.keys(part).length));
