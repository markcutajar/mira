// Every picture the sky draws has a name here. The drawn art paints them all in code; an art pack
// replaces it by providing the same names (decision 25), and nothing else in the sky changes.
//
// To use a pack: write a module that implements `Art`, load the pack's atlas in `preload`, map its
// frames to these names in `create` (scene.textures can add frames under any key), and give each
// building-like picture an anchor. Then pass it to the scene instead of `drawnArt()`.

import type { Season } from './daylight.ts';
import type { Palette } from './mirling.ts';
import type { HouseStyle } from './world.ts';

/** Label colours, one per section in turn. */
export type Accent = 'y' | 'l' | 'o' | 'c' | 'p' | 'g';
export const ACCENTS: Accent[] = ['y', 'c', 'l', 'o', 'p', 'g'];
export const ACCENT_COLOUR: Record<Accent, string> = { y: '#ffd34d', l: '#c8a6ff', o: '#ff8a3d', c: '#6ff3ff', p: '#ff9ec7', g: '#9be36b' };

/** A mirling's two walking frames, and asleep (decision 62). */
export type Frame = 'a' | 'b' | 'asleep';
export type { HouseStyle, Palette, Season };
/** Ground tiles; a bridge's deck has its planks across the way it's crossed. */
export type TileKind = 'grass0' | 'grass1' | 'grass2' | 'flowers' | 'path' | 'water' | 'deck-c' | 'deck-r';
export type Decoration =
  | 'pine' | 'shrub' | 'flowerbed' | 'sunflowers' | 'mushrooms'
  | 'lamp' | 'bench' | 'statue' | 'rock' | 'crates' | 'well' | 'campfire'
  | 'lilies' | 'boat';
/** The edges of a tile's diamond: north-east and north-west at the back, south-east and south-west in front. */
export type Edge = 'ne' | 'nw' | 'se' | 'sw';
/** What a mirling holds while it works (decision 41): a book to read, a hammer to make, a console to run. */
export type Prop = 'book.a' | 'book.b' | 'hammer' | 'spark' | 'console.a' | 'console.b';
export const MAX_LEVEL = 5;
export const WATERFALL_FRAMES = 3;

export const names = {
  tile: (kind: TileKind) => `tile.${kind}`,
  /** A bridge's rail along one edge of its tile; the back ones stand behind a mirling crossing, the front ones before it. */
  rail: (edge: Edge) => `rail.${edge}`,
  /** Water pouring off the island where a stream reaches a front edge, hung from that edge of its tile. */
  waterfall: (edge: 'se' | 'sw', frame: number) => `waterfall.${edge}.${frame}`,
  tree: (apples: boolean) => (apples ? 'tree.apple' : 'tree'),
  house: (style: HouseStyle, lit: boolean) => `house.${style}.${lit ? 'lit' : 'dark'}`,
  /** Libraries and workshops grow taller with their level, 1 to MAX_LEVEL. */
  building: (type: 'library' | 'workshop', level: number) => `${type}.${level}`,
  /** Plants, decorations and things on the water placed in build mode (decisions 39 and 44); placed oaks and apple trees use `tree`. */
  item: (kind: Decoration) => `item.${kind}`,
  /** Where mirlings wait for me (decisions 41 and 49): the swings' frame, without its seats, the slide and the trampoline. */
  play: (kind: 'swings' | 'slide' | 'trampoline') => `play.${kind}`,
  /** A rubber ring on the pond, in two halves so the mirling sits inside it. */
  ring: (half: 'back' | 'front') => `ring.${half}`,
  prop: (kind: Prop) => `prop.${kind}`,
  /** The bubble over a mirling thinking, with one, two or three dots. */
  thought: (frame: number) => `thought.${frame}`,
  /** The hourglass over a mirling waiting on work it started (decision 56), its sand running down in three frames. */
  hourglass: (frame: number) => `hourglass.${frame}`,
  /** The bolt over a mirling whose session and another are editing the same file (decision 58), bright and dim in turn. */
  clash: (frame: number) => `clash.${frame}`,
  /** The tile under the pointer in build mode: green where the tool can work, red where it can't. */
  cursor: (ok: boolean) => (ok ? 'cursor.ok' : 'cursor.bad'),
  creature: (palette: Palette, frame: Frame) => `creature.${palette}.${frame}`,
  helper: (palette: Palette, frame: 'a' | 'b') => `helper.${palette}.${frame}`,
  /** The glow of a light at night (decision 62), laid over the island: warm lamplight, or a flickering fire. */
  glow: (kind: 'warm' | 'fire') => `glow.${kind}`,
  /** What the seasons bring: a jack-o'-lantern, a snowman, and what falls from the sky, one pixel or two. */
  seasonal: (kind: 'pumpkin' | 'snowman') => `seasonal.${kind}`,
  flake: (kind: 'snow' | 'leaf' | 'petal') => `flake.${kind}`,
  /** Mira, the star, in the sky behind the island. */
  star: 'star.mira',
  /** The z's rising from a sleeping mirling. */
  zzz: 'zzz',
  /** Wildlife (decision 63): a bird and a butterfly flapping in two frames, a fish, the rings of its splash, a cloud and a firefly. */
  bird: (frame: 'a' | 'b') => `bird.${frame}`,
  butterfly: (frame: 'a' | 'b') => `butterfly.${frame}`,
  fish: 'fish',
  splash: (frame: number) => `splash.${frame}`,
  cloud: (i: number) => `cloud.${i}`,
  firefly: 'firefly',
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

/** A point in pixels from the centre of a tile, where its ground is. */
export interface Point {
  x: number;
  y: number;
}

export interface Art {
  /** Screen pixels per art pixel before zoom: 2 for the detailed art (decision 14). */
  readonly scale: number;
  /** The top diamond of a ground tile, and the depth of its side. */
  readonly tile: { w: number; h: number; side: number };
  /** Heights of the creature, beacon, bubble and thought pictures, for placing marks above heads. */
  readonly sizes: { creature: number; beacon: number; bubble: number; thought: number };
  /**
   * Where mirlings play on the playground's pictures: each swing seat's pivot under the frame and its
   * rope's length, which the scene draws as it swings; the foot of the slide's ladder, its top and
   * the end of its chute; and where on a trampoline's mat each of its two jumpers stands.
   */
  readonly playground: { swings: { pivots: Point[]; rope: number }; slide: { ladder: Point; top: Point; foot: Point }; trampoline: { spots: Point[] } };
  /** Where light shines from at night, from the ground point of a lamp, a campfire, a house, a jack-o'-lantern, a workshop and a library. */
  readonly lights: Record<'lamp' | 'campfire' | 'house' | 'pumpkin' | 'workshop' | 'library', Point>;
  /** Starts loading any files, for art that comes from a pack. */
  preload?(scene: Phaser.Scene): void;
  /** Makes every named texture available to the scene, dressed for the season. */
  create(scene: Phaser.Scene, season: Season): void;
  /** Redraws what changes with the seasons, the grass, paths and trees, under the same names, so what shows them changes at once. */
  dress(scene: Phaser.Scene, season: Season): void;
  /** The anchor of a building, tree, rail or playground picture; pictures without one stand on their bottom centre. */
  anchor(key: string): Anchor;
  /** The rock under the island, given the lowest ground pixel of each column; returns its texture name. */
  underside(scene: Phaser.Scene, columns: Map<number, number>, key: string): void;
}
