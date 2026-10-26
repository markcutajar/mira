// Every picture the sky draws has a name here. The drawn art paints them all in code; an art pack
// replaces it by providing the same names (decision 25), and nothing else in the sky changes.
//
// To use a pack: write a module that implements `Art`, load the pack's atlas in `preload`, map its
// frames to these names in `create` (scene.textures can add frames under any key), and give each
// building-like picture an anchor. Then pass it to the scene instead of `drawnArt()`.

/** Hedge and label colours, one per section in turn. */
export type Accent = 'y' | 'l' | 'o' | 'c' | 'p' | 'g';
export const ACCENTS: Accent[] = ['y', 'c', 'l', 'o', 'p', 'g'];
export const ACCENT_COLOUR: Record<Accent, string> = { y: '#ffd34d', l: '#c8a6ff', o: '#ff8a3d', c: '#6ff3ff', p: '#ff9ec7', g: '#9be36b' };

/** Creature colours: yellow, and grey when failed. */
export type Palette = 'y' | 'g';
export type Frame = 'a' | 'b';
export type HouseStyle = 'brick' | 'timber' | 'stone';
export type TileKind = 'grass0' | 'grass1' | 'grass2' | 'flowers' | 'path' | 'water';
export const MAX_LEVEL = 5;

export const names = {
  tile: (kind: TileKind) => `tile.${kind}`,
  hedge: (accent: Accent) => `hedge.${accent}`,
  tree: (apples: boolean) => (apples ? 'tree.apple' : 'tree'),
  house: (style: HouseStyle, lit: boolean) => `house.${style}.${lit ? 'lit' : 'dark'}`,
  /** Libraries and workshops grow taller with their level, 1 to MAX_LEVEL. */
  building: (type: 'library' | 'workshop', level: number) => `${type}.${level}`,
  creature: (palette: Palette, frame: Frame) => `creature.${palette}.${frame}`,
  helper: (palette: Palette, frame: Frame) => `helper.${palette}.${frame}`,
  beacon: 'beacon',
  bubble: 'bubble',
  smoke: 'smoke',
  select: 'select',
};

/** Where a picture stands on its tile: its origin as fractions, and the height of its top above the ground point. */
export interface Anchor {
  ox: number;
  oy: number;
  height: number;
}

export interface Art {
  /** Screen pixels per art pixel before zoom: 2 for the detailed art (decision 14). */
  readonly scale: number;
  /** The top diamond of a ground tile, and the depth of its side. */
  readonly tile: { w: number; h: number; side: number };
  /** Heights of the creature, beacon and bubble pictures, for placing marks above heads. */
  readonly sizes: { creature: number; beacon: number; bubble: number };
  /** Starts loading any files, for art that comes from a pack. */
  preload?(scene: Phaser.Scene): void;
  /** Makes every named texture available to the scene. */
  create(scene: Phaser.Scene): void;
  /** The anchor of a building, hedge or tree; pictures without one stand on their bottom centre. */
  anchor(key: string): Anchor;
  /** The rock under the island, given the lowest ground pixel of each column; returns its texture name. */
  underside(scene: Phaser.Scene, columns: Map<number, number>, key: string): void;
}
