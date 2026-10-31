// Placeholder pixel art, drawn in code at the detailed 2× size (decisions 14 and 25). Every
// picture is registered under a name from art.ts, so an art pack can replace this module whole.

import { MAX_LEVEL, names, WATERFALL_FRAMES, type Anchor, type Art, type Edge, type HouseStyle, type Palette, type Point, type Season } from './art.ts';
import { ASLEEP, MIRLING, PALETTES } from './mirling.ts';

type Ctx = CanvasRenderingContext2D;

const A = 2; // screen pixels per art pixel
const TW = 32 * A;
const TH = 16 * A;
const SIDE = 8 * A;

const C = {
  grass: ['#4f9a3c', '#55a141', '#4a9238'], grassSpeck: ['#62b84f', '#3f8530', '#5aad46'], lip: '#3a7a2c',
  dirt: '#9b6b3f', dirtSpeck: ['#b07e4c', '#86592f'], dirtLip: '#7d5430',
  water: '#3d7fd1', waterGlint: '#8cc4f5', waterRim: '#2c5ea0',
  sideL: '#7a5233', sideR: '#5e3e26', strata: '#4b3120',
  rock: ['#3b2a2a', '#33242a'], rockDeep: '#261b22', crystal: ['#6ff3ff', '#b48cff'],
  flowers: ['#f4f1e6', '#ffd34d', '#ff9ec7'],
};

const PAL = PALETTES;

/** What the seasons change (decision 62): the grass and its flowers, the leaves, blossom in spring and snow in winter. */
interface Dress {
  grass: string[];
  speck: string[];
  lip: string;
  tuft: [string, string];
  flowers: string[];
  pathSpeck: string[];
  leaf: { edge: string; light: string; mid: string; dark: string; shine: string };
  bloom?: string[];
  snow?: boolean;
  apples: boolean;
}
const SNOW = '#f4f8fc';
const DRESS: Record<Season, Dress> = {
  spring: {
    grass: ['#57a63f', '#5cad45', '#50a03c'], speck: ['#6cc457', '#45903a', '#64ba50'], lip: C.lip, tuft: ['#3a7a2c', '#86d86a'],
    flowers: ['#f4f1e6', '#ffd34d', '#ff9ec7', '#c8a6ff'], pathSpeck: C.dirtSpeck,
    leaf: { edge: '#2a5e2c', light: '#72c85a', mid: '#4a9c40', dark: '#347530', shine: '#8ee070' }, bloom: ['#ffc4dc', '#fff0f5', '#ff9ec7'], apples: false,
  },
  summer: {
    grass: C.grass, speck: C.grassSpeck, lip: C.lip, tuft: ['#3a7a2c', '#7fd062'], flowers: C.flowers, pathSpeck: C.dirtSpeck,
    leaf: { edge: '#24552a', light: '#62b84f', mid: '#3f8f3a', dark: '#2d6b2b', shine: '#7fd062' }, apples: true,
  },
  autumn: {
    grass: ['#7a9a3c', '#83a040', '#709238'], speck: ['#9aae4a', '#5f8530', '#d98a3a'], lip: '#5f7a2c', tuft: ['#5f7a2c', '#b8b050'],
    flowers: ['#ffd34d', '#ff8a3d', '#c84a3a'], pathSpeck: [...C.dirtSpeck, '#d98a3a'],
    leaf: { edge: '#6b2e14', light: '#f2b03a', mid: '#e07a2a', dark: '#b8452a', shine: '#ffd36a' }, apples: true,
  },
  winter: {
    grass: ['#e6ecf3', '#edf1f6', '#dfe7f0'], speck: ['#ffffff', '#cbd6e4', '#d8e1ec'], lip: '#c3cfdf', tuft: ['#6a8a5a', '#8aa67a'],
    flowers: ['#f4f1e6', '#b8c7ff', '#d6c2ff'], pathSpeck: [...C.dirtSpeck, '#e6ecf3', SNOW],
    leaf: { edge: '#1b3326', light: '#4d6e55', mid: '#3a5a45', dark: '#2a4636', shine: '#5f8066' }, snow: true, apples: false,
  },
};

// Hand-placed pixel maps; each letter is a colour from the palette passed with it.
const MAPS = {
  creature: MIRLING,
  helper: {
    a: ['....oooo....', '..oohyyyoo..', '.ohyyyyyyso.', '.oyeyyyeyso.', 'oyyeyyyeyyso', 'oyyyymmyyyso', 'oyyyyyyyyyso', '.osyyyyysso.', '..oosssssoo.', '....oooo....', '...of..fo...', '...oo..oo...'],
    b: ['....oooo....', '..oohyyyoo..', '.ohyyyyyyso.', '.oyeyyyeyso.', 'oyyeyyyeyyso', 'oyyyymmyyyso', 'oyyyyyyyyyso', '.osyyyyysso.', '..oosssssoo.', '....oooo....', '..of....fo..', '..oo....oo..'],
  },
  beacon: ['....oooo....', '..ooOOOOoo..', '.ohOOOOOOOo.', '.ohOOwwOOOo.', 'oOOOOwwOOOOo', 'oOOOOwwOOOOo', 'oOOOOwwOOOOo', 'oOOOOwwOOOOo', 'oOOOOOOOOOOo', 'oOOOOwwOOOOo', '.oOOOwwOOOo.', '.oOOOOOOOOo.', '..ooOOOOoo..', '....oOOo....', '.....oo.....', '.....oo.....'],
  bubble: ['..oooooooooooo..', '.oWWWWWWWWWWWWo.', 'oWWWWWWWWWWWWWWo', 'oWWddWWddWWddWWo', 'oWWddWWddWWddWWo', 'oWWWWWWWWWWWWWWo', '.oWWWWWWWWWWWWo.', '..oooWWooooooo..', '....oWWo........', '....oWo.........', '....oo..........'],
  smoke: ['..gggg..', '.gGGGGg.', 'gGGhGGGg', 'gGhGGGGg', 'gGGGGGGg', 'gGGGGGgg', '.gGGGgg.', '..gggg..'],
  // Dots go in at row 4, columns 4, 7 and 10.
  thought: ['....oooo.oooo...', '..ooWWWWoWWWWoo.', '.oWWWWWWWWWWWWWo', 'oWWWWWWWWWWWWWWo', 'oWWWWWWWWWWWWWWo', '.oWWWWWWWWWWWWo.', '..ooWWWooWWWoo..', '....ooo..ooo....', '..oo............', '.oWWo...........', '..oo............', 'oo..............'],
  // Sand falling through, from a full top bulb to a full bottom one.
  hourglass: [
    ['bbbbbbbbb', '.oWWWWWo.', '.oSSSSSo.', '..oSSSo..', '...oSo...', '...oSo...', '...oSo...', '..oWWWo..', '.oWWWWWo.', '.oWWSWWo.', 'bbbbbbbbb'],
    ['bbbbbbbbb', '.oWWWWWo.', '.oWWWWWo.', '..oSSSo..', '...oSo...', '...oSo...', '...oSo...', '..oWWWo..', '.oWWSWWo.', '.oSSSSSo.', 'bbbbbbbbb'],
    ['bbbbbbbbb', '.oWWWWWo.', '.oWWWWWo.', '..oWWWo..', '...oSo...', '...oSo...', '...oSo...', '..oWSWo..', '.oSSSSSo.', '.oSSSSSo.', 'bbbbbbbbb'],
  ],
  clash: ['....oooo', '...oYYYo', '..oYYYo.', '.oYYYo..', 'oYYYYYYo', 'ooooYYo.', '...oYo..', '..oYo...', '.oYo....', '.oo.....'],
  book: {
    a: ['oo......oo', 'oWoo..ooWo', 'oWWWooWWWo', 'oWllWWllWo', 'oWWWWWWWWo', 'oBBBBBBBBo', '.oooooooo.'],
    b: ['oo...o..oo', 'oWoooWooWo', 'oWWWoWoWWo', 'oWllWoWlWo', 'oWWWWWWWWo', 'oBBBBBBBBo', '.oooooooo.'],
  },
  hammer: ['oooooo', 'oGGGHo', 'oGGGGo', 'oooooo', '..ob..', '..ob..', '..ob..', '..ob..', '..ob..', '..oo..'],
  spark: ['..y..', '.yWy.', 'yWWWy', '.yWy.', '..y..'],
  // A jack-o'-lantern with a candle in it, and a snowman in a hat and scarf (decision 62).
  pumpkin: ['......bb.....', '.....bg......', '..ooooooooo..', '.oOOdOOOdOOo.', 'oOOOdOOOdOOOo', 'oOYYdOOOdYYOo', 'oOOYdOOOdYOOo', 'oOOOdOYOdOOOo', 'oOYOYOYOYOYOo', '.oOYYYYYYYOo.', '..ooooooooo..'],
  snowman: ['....oooo....', '....oKKo....', '...oKKKKo...', '..oooooooo..', '...oWWWWo...', '..oWeWWeWo..', '..oWWNNWWo..', '..oWWWWWWo..', '...oRRRRo...', '..oWWRWWWo..', '.oWWWRWbWWo.', 'oWWWWWWWWWWo', 'oWWWWWbWWWSo', 'oWWWWWWWWWSo', '.oWWWWWWWSo.', '..oooooooo..'],
  star: ['....a....', '....a....', '....r....', '...rcr...', 'aarcWcraa', '...rcr...', '....r....', '....a....', '....a....'],
  zzz: ['zzzz', '...z', '..z.', '.z..', 'zzzz'],
  // Wildlife (decision 63): a bird with its wings up and down, a butterfly open and shut, drawn white
  // so the scene can colour each one, a goldfish, and the two rings of its splash.
  bird: { a: ['o.......o', 'wo.....ow', '.ww.o.ww.', '...www...'], b: ['.........', '...www...', '.wwwowww.', 'wo.....ow'] },
  butterfly: { a: ['ww.ww', 'wWbWw', '.wbw.', '.w.w.'], b: ['.w.w.', '.wbw.', '..b..', '.....'] },
  fish: ['.ooo..o', 'oOOOOoo', '.ooo..o'],
  splash: [['..wwww..', '.w....w.', '..wwww..'], ['...wwwwww...', '.ww......ww.', '...wwwwww...']],
  console: {
    a: ['ooooooooooo', 'oKKKKKKKKKo', 'oKggKgggKKo', 'oKgggKKKKKo', 'oKggggKgKKo', 'oKgKKKKKKKo', 'ooooooooooo', '.oSSSSSSSo.', 'ooooooooooo'],
    b: ['ooooooooooo', 'oKKKKKKKKKo', 'oKgggKggKKo', 'oKggKgggKKo', 'oKgggggKKKo', 'oKgcKKKKKKo', 'ooooooooooo', '.oSSSSSSSo.', 'ooooooooooo'],
  },
};

// The playground's geometry in pixels from its tile's ground point (decision 41), shared by the
// pictures and the scene: one tile along a column or row, swings across the rows, slide down the columns.
const ALONG_C = { x: TW / 2, y: TH / 2 };
const ALONG_R = { x: -TW / 2, y: TH / 2 };
const at = (c: number, r: number, up = 0): Point => ({ x: Math.round(ALONG_C.x * c + ALONG_R.x * r), y: Math.round(ALONG_C.y * c + ALONG_R.y * r - up) });
const SWING_TOP = 18 * A;
const SLIDE_TOP = 20 * A;
const MAT_UP = 5 * A; // a trampoline's mat, above the ground
const PLAYGROUND = {
  swings: { pivots: [at(0, -0.16, SWING_TOP), at(0, 0.16, SWING_TOP)], rope: 12 * A },
  slide: { ladder: at(-0.3, 0), top: at(-0.24, 0, SLIDE_TOP), foot: at(0.36, 0, A) },
  trampoline: { spots: [at(0, -0.14, MAT_UP), at(0, 0.14, MAT_UP)] },
};

/** A pixel line from one point to another, `t` pixels thick. */
function line(ctx: Ctx, color: string, x0: number, y0: number, x1: number, y1: number, t = 1) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    rect(ctx, color, x - Math.floor(t / 2), y - Math.floor(t / 2), t, t);
  }
}

/** A repeatable number in [0, 1) for two integers, for patterns that must match between frames. */
function noise(a: number, b: number): number {
  const n = Math.imul(Math.imul(a + 17, 374761393) ^ Math.imul(b + 31, 668265263), 1274126177);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(list: T[], rnd: () => number) => list[Math.floor(rnd() * list.length)] as T;

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `#${((1 << 24) | (ch((n >> 16) & 255) << 16) | (ch((n >> 8) & 255) << 8) | ch(n & 255)).toString(16).slice(1)}`;
}

function rect(ctx: Ctx | null, color: string, x: number, y: number, w: number, h: number) {
  if (!ctx) return;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

/** A stepped 2:1 diamond centred on (cx, cy); records the lowest painted row of each column. */
function diamond(ctx: Ctx | null, color: string, cx: number, cy: number, hw: number, bottoms?: number[]) {
  const hh = hw / 2;
  for (let i = 0; i < hh; i++) {
    const half = (i + 1) * 2;
    rect(ctx, color, cx - half, cy - hh + i, half * 2, 1);
  }
  for (let i = 0; i < hh; i++) {
    const half = hw - i * 2;
    rect(ctx, color, cx - half, cy + i, half * 2, 1);
    if (bottoms) for (let x = cx - half; x < cx + half; x++) bottoms[x] = cy + i;
  }
}

function bottomsFor(cx: number, cy: number, hw: number): number[] {
  const bottoms: number[] = [];
  diamond(null, '', cx, cy, hw, bottoms);
  return bottoms;
}

const TILE_BOTTOMS = bottomsFor(TW / 2, TH / 2, TW / 2);
const insideTile = (x: number, y: number) => Math.abs(x + 0.5 - TW / 2) / (TW / 2) + Math.abs(y + 0.5 - TH / 2) / (TH / 2) <= 0.86;

/** An isometric box with a flat or pyramid roof. Sizes are in 1× units and scaled by A here. */
interface BuildingSpec {
  hw: number;
  wallH: number;
  roofH?: number;
  extraTop?: number;
  texture?: 'brick' | 'timber' | 'stone' | 'planks';
  wallL: string;
  wallR: string;
  top?: string;
  topInner?: string;
  roofL?: string;
  roofR?: string;
  eave?: string;
  walls?: (ctx: Ctx, cx: number, bottoms: number[], wallH: number, hw: number) => void;
  extras?: (ctx: Ctx, cx: number, topY: number, roofH: number) => void;
}

export function drawnArt(): Art {
  const anchors = new Map<string, Anchor>();
  let scene!: Phaser.Scene;

  let season: Season = 'summer';

  // A picture that changes with the seasons is drawn again on its own canvas, so whatever shows it
  // changes at once; any other is drawn once.
  function canvasTex(key: string, w: number, h: number, draw: (ctx: Ctx) => void, again = false) {
    if (scene.textures.exists(key)) {
      const tex = scene.textures.get(key);
      if (!again || !(tex instanceof Phaser.Textures.CanvasTexture)) return;
      tex.context.clearRect(0, 0, tex.width, tex.height);
      tex.context.imageSmoothingEnabled = false;
      draw(tex.context);
      tex.refresh();
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d') as Ctx;
    ctx.imageSmoothingEnabled = false;
    draw(ctx);
    scene.textures.addCanvas(key, canvas);
  }

  function pixelMap(key: string, rows: string[], palette: Record<string, string>) {
    canvasTex(key, rows[0]?.length ?? 1, rows.length, (ctx) => {
      rows.forEach((row, y) => [...row].forEach((ch, x) => { const color = palette[ch]; if (color) rect(ctx, color, x, y, 1, 1); }));
    });
  }

  function tileTex(key: string, top: string, speckles: string[], lip: string, rnd: () => number, extra?: (ctx: Ctx) => void, sides: [string, string] = [C.sideL, C.sideR], again = false) {
    canvasTex(key, TW, TH + SIDE, (ctx) => {
      diamond(ctx, top, TW / 2, TH / 2, TW / 2);
      for (let i = 0; i < 22 * A * A; i++) {
        const x = Math.floor(rnd() * TW);
        const y = Math.floor(rnd() * TH);
        if (insideTile(x, y)) rect(ctx, pick(speckles, rnd), x, y, 1, 1);
      }
      extra?.(ctx);
      for (let x = 0; x < TW; x++) {
        const b = TILE_BOTTOMS[x] ?? 0;
        for (let k = 1; k <= SIDE; k++) {
          let color = x < TW / 2 ? sides[0] : sides[1];
          if (k <= A) color = lip;
          else if (k % (3 * A) === 0) color = C.strata;
          else if (rnd() < 0.03) color = '#8a6240';
          rect(ctx, color, x, b + k, 1, 1);
        }
      }
    }, again);
  }

  function building(key: string, raw: BuildingSpec) {
    const hw = raw.hw * A;
    const wallH = raw.wallH * A;
    const roofH = (raw.roofH ?? 0) * A;
    const extraTop = (raw.extraTop ?? 0) * A;
    const w = hw * 2 + 2;
    const h = wallH + roofH + hw + 2 + extraTop;
    const cx = hw + 1;
    const gy = h - hw / 2;
    const bottoms = bottomsFor(cx, gy, hw);
    anchors.set(key, { ox: cx / w, oy: gy / h, height: gy });
    canvasTex(key, w, h, (ctx) => {
      for (let x = cx - hw; x < cx + hw; x++) rect(ctx, x < cx ? raw.wallL : raw.wallR, x, (bottoms[x] ?? 0) - wallH + 1, 1, wallH);
      if (raw.texture) {
        for (let x = cx - hw; x < cx + hw; x++) {
          const line = raw.texture === 'timber' ? '#6b4a2e' : shade(x < cx ? raw.wallL : raw.wallR, raw.texture === 'brick' ? 1.16 : 0.88);
          for (let k = 1; k < wallH; k++) {
            const course = Math.floor(k / 3);
            const mark = raw.texture === 'brick' ? k % 3 === 0 || (x + (course % 2) * 3) % 6 === 0
              : raw.texture === 'stone' ? k % 4 === 0 || (x + (Math.floor(k / 4) % 2) * 4) % 8 === 0
              : raw.texture === 'timber' ? (x - cx) % 5 === 0 || k === Math.floor(wallH / 2)
              : (x - cx) % 3 === 0;
            if (mark) rect(ctx, line, x, (bottoms[x] ?? 0) - k, 1, 1);
          }
        }
      }
      raw.walls?.(ctx, cx, bottoms, wallH, hw);
      const topY = gy - wallH;
      if (!roofH) {
        diamond(ctx, raw.top ?? raw.wallL, cx, topY, hw);
        diamond(ctx, raw.topInner ?? raw.top ?? raw.wallL, cx, topY, hw - 2 * A);
      } else {
        for (let x = cx - hw; x < cx + hw; x++) {
          const t = 1 - Math.abs(x + 0.5 - cx) / hw;
          const yTop = Math.round(topY - roofH * t);
          const yBot = (bottoms[x] ?? 0) - wallH;
          const base = (x < cx ? raw.roofL : raw.roofR) ?? raw.wallL;
          rect(ctx, base, x, yTop, 1, yBot - yTop + 1);
          for (let y = yBot - 2; y > yTop; y -= 3) rect(ctx, shade(base, 0.82), x, y, 1, 1);
          rect(ctx, raw.eave ?? base, x, yBot, 1, 1);
        }
      }
      raw.extras?.(ctx, cx, topY, roofH);
    });
  }

  // Streams (decision 42): a bridge's rails, one per edge of its tile, and water pouring off the
  // island's front edges, in frames that loop as it falls.
  function waterworks() {
    const lift = 8 * A;
    const corners: Record<'top' | 'right' | 'bottom' | 'left', Point> = { top: { x: TW / 2, y: lift }, right: { x: TW, y: lift + TH / 2 }, bottom: { x: TW / 2, y: lift + TH }, left: { x: 0, y: lift + TH / 2 } };
    const edges: Record<Edge, [Point, Point]> = { ne: [corners.top, corners.right], se: [corners.right, corners.bottom], sw: [corners.bottom, corners.left], nw: [corners.left, corners.top] };
    const mid = { x: TW / 2, y: lift + TH / 2 };
    const inward = (p: Point, f: number) => ({ x: Math.round(p.x + (mid.x - p.x) * f), y: Math.round(p.y + (mid.y - p.y) * f) });
    for (const [edge, [from, to]] of Object.entries(edges) as Array<[Edge, [Point, Point]]>) {
      const key = names.rail(edge);
      anchors.set(key, { ox: 0.5, oy: mid.y / (TH + lift), height: mid.y });
      canvasTex(key, TW, TH + lift, (ctx) => {
        const a = inward(from, 0.16);
        const b = inward(to, 0.16);
        const high = 5 * A;
        for (const t of [0.08, 0.5, 0.92]) {
          const x = Math.round(a.x + (b.x - a.x) * t);
          const y = Math.round(a.y + (b.y - a.y) * t);
          rect(ctx, '#4a2e1c', x, y - high, A, high + A);
        }
        line(ctx, '#8a5a32', a.x, a.y - high, b.x, b.y - high, A);
        line(ctx, '#c48a58', a.x, a.y - high - 1, b.x, b.y - high - 1, 1);
        line(ctx, '#6b4423', a.x, a.y - Math.round(high / 2), b.x, b.y - Math.round(high / 2), 1);
      });
    }

    const fall = 44 * A;
    const shift = 3 * A;
    for (const edge of ['se', 'sw'] as const) {
      for (let frame = 0; frame < WATERFALL_FRAMES; frame++) {
        canvasTex(names.waterfall(edge, frame), TW / 2, TH / 2 + fall, (ctx) => {
          for (let x = 0; x < TW / 2; x++) {
            // The column starts on the tile's edge: rising to its right corner, or falling to its bottom one.
            const top = edge === 'se' ? TH / 2 - Math.floor(x / 2) : Math.floor(x / 2);
            const lane = Math.floor(x / A);
            for (let k = 0; k < fall; k++) {
              const step = (((Math.floor((k - frame * shift) / shift)) % WATERFALL_FRAMES) + WATERFALL_FRAMES) % WATERFALL_FRAMES;
              const streak = noise(lane, step) < 0.35;
              ctx.globalAlpha = k < fall * 0.55 ? 1 : Math.max(0, 1 - (k - fall * 0.55) / (fall * 0.45));
              rect(ctx, k < A ? '#d8ecff' : streak ? C.waterGlint : C.water, x, top + k, 1, 1);
            }
          }
          ctx.globalAlpha = 1;
        });
      }
    }
  }

  // Where mirlings wait for me (decisions 41 and 49): swings without their seats, which the scene hangs
  // and swings, a slide with its ladder at the back and its chute coming down towards the front, and a
  // round trampoline on short legs, its mat ringed with striped padding.
  function playground() {
    const w = TW;
    const ground = (h: number) => ({ x: TW / 2, y: h - TH / 2 });

    const sh = SWING_TOP + 8 * A + TH;
    const sg = ground(sh);
    anchors.set(names.play('swings'), { ox: sg.x / w, oy: sg.y / sh, height: sg.y });
    canvasTex(names.play('swings'), w, sh, (ctx) => {
      const p = (c: number, r: number, up = 0) => { const q = at(c, r, up); return { x: sg.x + q.x, y: sg.y + q.y }; };
      for (const end of [-0.36, 0.36]) {
        const top = p(0, end, SWING_TOP);
        for (const foot of [-0.2, 0.2]) {
          const g = p(foot, end);
          line(ctx, foot < 0 ? '#2c4466' : '#3a5a8a', top.x, top.y, g.x, g.y, A);
        }
      }
      const a = p(0, -0.36, SWING_TOP);
      const b = p(0, 0.36, SWING_TOP);
      line(ctx, '#4a6fa5', a.x, a.y, b.x, b.y, A);
      line(ctx, '#7d93c4', a.x, a.y - 1, b.x, b.y - 1, 1);
    });

    const dh = SLIDE_TOP + 10 * A + TH;
    const dg = ground(dh);
    anchors.set(names.play('slide'), { ox: dg.x / w, oy: dg.y / dh, height: dg.y });
    canvasTex(names.play('slide'), w, dh, (ctx) => {
      const p = (q: Point) => ({ x: dg.x + q.x, y: dg.y + q.y });
      const { ladder, top, foot } = PLAYGROUND.slide;
      const side = at(0, 0.09);
      // The ladder: two rails up to the platform, with rungs.
      for (const s of [-1, 1]) {
        const g = p({ x: ladder.x + s * side.x, y: ladder.y + s * side.y });
        line(ctx, '#8a8a98', g.x, g.y, g.x, g.y - SLIDE_TOP - 3 * A, A);
      }
      for (let up = 3 * A; up < SLIDE_TOP; up += 3 * A) {
        const a = p({ x: ladder.x - side.x, y: ladder.y - side.y - up });
        const b = p({ x: ladder.x + side.x, y: ladder.y + side.y - up });
        line(ctx, '#b9b9c2', a.x, a.y, b.x, b.y, 1);
      }
      const deck = p({ x: ladder.x, y: ladder.y - SLIDE_TOP });
      isoBlock(ctx, deck.x, deck.y + A, 4 * A, A, '#6e6e78', '#5a5a63', '#b9b9c2');
      // A post under the middle of the chute, then the chute itself, lipped on both sides.
      const t = p(top);
      const f = p(foot);
      const m = { x: Math.round((t.x + f.x) / 2), y: Math.round((t.y + f.y) / 2) };
      const under = p(at(0.03, 0));
      line(ctx, '#6e6e78', m.x, m.y, m.x, under.y, A);
      const steps = Math.max(Math.abs(f.x - t.x), Math.abs(f.y - t.y)) * 2;
      for (let i = 0; i <= steps; i++) {
        const x = t.x + ((f.x - t.x) * i) / steps;
        const y = t.y + ((f.y - t.y) * i) / steps;
        line(ctx, i % 6 < 3 ? '#ffd34d' : '#ffe08a', Math.round(x - side.x), Math.round(y - side.y), Math.round(x + side.x), Math.round(y + side.y), 1);
      }
      for (const s of [-1, 1]) line(ctx, '#e07a3f', t.x + s * side.x, t.y + s * side.y - A, f.x + s * side.x, f.y + s * side.y - A, A);
    });

    const th = MAT_UP + 4 * A + TH;
    const tg = ground(th);
    anchors.set(names.play('trampoline'), { ox: tg.x / w, oy: tg.y / th, height: tg.y - MAT_UP });
    canvasTex(names.play('trampoline'), w, th, (ctx) => {
      const cx = tg.x / A;
      const cy = (tg.y - MAT_UP) / A;
      const rx = 12;
      const ry = 6;
      // Four legs from under the rim, then the frame's edge, then the mat with its padding on top.
      for (const [lx, ly] of [[-0.8, 0], [0.8, 0], [0, -0.8], [0, 0.8]] as const) {
        const x = Math.round((cx + lx * rx) * A);
        const y = Math.round((cy + ly * ry) * A);
        line(ctx, lx < 0 || ly < 0 ? '#3a3f55' : '#555a70', x, y, x, y + MAT_UP, A);
      }
      const inside = (x: number, y: number, dy = 0) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy - dy) / ry) ** 2 <= 1;
      for (let y = 0; y < th / A; y++) {
        for (let x = 0; x < w / A; x++) {
          if (inside(x, y, 1) && !inside(x, y)) rect(ctx, '#2c5a8f', x * A, y * A, A, A);
          if (!inside(x, y)) continue;
          const d = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
          const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
          const band = Math.floor((Math.atan2((y + 0.5 - cy) / ry, (x + 0.5 - cx) / rx) + Math.PI) / (Math.PI / 6)) % 2 === 0;
          const colour = edge ? '#1f3a5c' : d > 0.5 ? (band ? '#4a90e2' : '#f4f1e6') : d < 0.15 && y + 0.5 < cy ? '#6a7396' : '#4f5778';
          rect(ctx, colour, x * A, y * A, A, A);
        }
      }
    });
  }

  // A rubber ring, red and white, cut across its middle: the back half behind the mirling, the front before it.
  function ring() {
    const w = 22;
    const h = 11;
    const cx = w / 2;
    const cy = h / 2;
    const inRing = (x: number, y: number) => {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      return (dx / 11) ** 2 + (dy / 5.5) ** 2 <= 1 && (dx / 5.5) ** 2 + (dy / 2.4) ** 2 > 1;
    };
    for (const half of ['back', 'front'] as const) {
      canvasTex(names.ring(half), w, h, (ctx) => {
        for (let y = 0; y < h; y++) {
          if ((half === 'back') !== (y + 0.5 < cy)) continue;
          for (let x = 0; x < w; x++) {
            if (!inRing(x, y)) continue;
            const edge = !inRing(x - 1, y) || !inRing(x + 1, y) || !inRing(x, y - 1) || !inRing(x, y + 1);
            const red = Math.floor((Math.atan2((y + 0.5 - cy) / 5.5, (x + 0.5 - cx) / 11) + Math.PI) / (Math.PI / 4)) % 2 === 0;
            const low = y + 0.5 > cy + 2;
            rect(ctx, edge ? '#7a2018' : red ? (low ? '#b8382a' : '#e04b3a') : low ? '#cfcabb' : '#f4f1e6', x, y, 1, 1);
          }
        }
      });
    }
  }

  // What a mirling holds while it works, and the bubble over one thinking.
  function props() {
    const book = { o: '#2a2f45', W: '#f4f1e6', l: '#9c9dbb', B: '#55658a' };
    pixelMap(names.prop('book.a'), MAPS.book.a, book);
    pixelMap(names.prop('book.b'), MAPS.book.b, book);
    pixelMap(names.prop('hammer'), MAPS.hammer, { o: '#34343c', G: '#8e8e98', H: '#d0d0d6', b: '#a8744a' });
    pixelMap(names.prop('spark'), MAPS.spark, { y: '#ffd34d', W: '#fff7ec' });
    const screen = { o: '#2a2f45', K: '#14182b', g: '#7bd389', c: '#e8fbe9', S: '#55658a' };
    pixelMap(names.prop('console.a'), MAPS.console.a, screen);
    pixelMap(names.prop('console.b'), MAPS.console.b, screen);
    for (let frame = 0; frame < 3; frame++) {
      const rows = MAPS.thought.map((row, y) => (y === 4 ? [...row].map((ch, x) => ([4, 7, 10].slice(0, frame + 1).some((d) => x === d || x === d + 1) ? 'd' : ch)).join('') : row));
      pixelMap(names.thought(frame), rows, { o: '#2a2f45', W: '#f4f1e6', d: '#5a5f7a' });
    }
    MAPS.hourglass.forEach((rows, frame) => pixelMap(names.hourglass(frame), rows, { b: '#a8744a', o: '#2a2f45', W: '#d6e9f5', S: '#ffd34d' }));
    pixelMap(names.clash(0), MAPS.clash, { o: '#2a2f45', Y: '#ffd34d' });
    pixelMap(names.clash(1), MAPS.clash, { o: '#2a2f45', Y: '#fff7ec' });
  }

  /** Leaves in the season's colours, lighter towards the top left, with snow lying on top in winter. */
  function foliage(ctx: Ctx, w: number, h: number, inside: (x: number, y: number) => boolean, rnd: () => number, slope: number) {
    const { leaf, snow } = DRESS[season];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside(x, y)) continue;
        const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        const light = (x + y) / slope + rnd() * 0.12;
        const top = snow && (!inside(x, y - 1) || !inside(x, y - 2) || (!inside(x, y - 3) && rnd() < 0.5));
        rect(ctx, top ? (edge ? '#c3cfdf' : SNOW) : edge ? leaf.edge : light < 0.42 ? leaf.light : light < 0.72 ? leaf.mid : leaf.dark, x, y, 1, 1);
      }
    }
  }

  /** Bright specks over leaves: the season's shine, and blossom in spring. */
  function specks(ctx: Ctx, w: number, h: number, inside: (x: number, y: number) => boolean, rnd: () => number, count: number) {
    const { leaf, bloom } = DRESS[season];
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rnd() * w);
      const y = Math.floor(rnd() * h);
      if (inside(x, y) && inside(x + 1, y + 1)) rect(ctx, bloom && i % 2 ? pick(bloom, rnd) : leaf.shine, x, y, 1, 1);
    }
  }

  function tree(key: string, apples: boolean, again = false) {
    const rnd = mulberry32(apples ? 77 : 55);
    const w = 22;
    const h = 28;
    const blobs: Array<[number, number, number]> = [[11, 10, 9], [6, 14, 5.5], [16, 14, 5.5]];
    const inside = (x: number, y: number) => blobs.some(([bx, by, br]) => Math.hypot(x + 0.5 - bx, y + 0.5 - by) <= br);
    canvasTex(key, w, h, (ctx) => {
      rect(ctx, '#6b4423', 9, 16, 4, 10);
      rect(ctx, '#4f311a', 12, 16, 1, 10);
      rect(ctx, '#6b4423', 8, 25, 6, 2);
      foliage(ctx, w, h, inside, rnd, w + 18);
      specks(ctx, w, 20, inside, rnd, DRESS[season].bloom ? 40 : 26);
      if (apples && DRESS[season].apples) for (const [x, y] of [[7, 9], [14, 7], [12, 15], [17, 13]] as Array<[number, number]>) { rect(ctx, '#e04b3a', x, y, 2, 2); rect(ctx, '#ff8a7a', x, y, 1, 1); }
    }, again);
  }

  function pine(again = false) {
    const rnd = mulberry32(91);
    canvasTex(names.item('pine'), 20, 34, (ctx) => {
      rect(ctx, '#6b4423', 9, 26, 3, 7);
      rect(ctx, '#4f311a', 11, 26, 1, 7);
      rect(ctx, '#6b4423', 8, 32, 5, 2);
      const tiers: Array<[number, number, number]> = [[1, 10, 4.5], [7, 11, 7], [13, 14, 9.4]];
      const inside = (x: number, y: number) => tiers.some(([y0, th, hw]) => y >= y0 && y < y0 + th && Math.abs(x + 0.5 - 10) <= 0.8 + (hw * (y - y0 + 1)) / th);
      blob(ctx, 20, 34, inside, (x, y) => {
        const light = (x - 10) / 20 + rnd() * 0.15 + (y % 6) / 30;
        return light < -0.05 ? '#4f9f5c' : light < 0.2 ? '#2f7a45' : '#225c36';
      }, '#173f27');
      // A pine keeps its needles all year: only the snow on each tier changes.
      if (DRESS[season].snow) for (let y = 0; y < 34; y++) for (let x = 0; x < 20; x++) if (inside(x, y) && !inside(x, y - 1)) rect(ctx, SNOW, x, y, 1, 1);
    }, again);
  }

  function shrub(again = false) {
    const rnd = mulberry32(13 + A);
    const blobs: Array<[number, number, number]> = [[7 * A, 5.5 * A, 5 * A], [4 * A, 7 * A, 3.5 * A], [10 * A, 7 * A, 3.5 * A]];
    const inside = (x: number, y: number) => blobs.some(([bx, by, br]) => Math.hypot(x + 0.5 - bx, y + 0.5 - by) <= br);
    canvasTex(names.item('shrub'), 14 * A, 11 * A, (ctx) => {
      const w = 14 * A;
      const h = 11 * A;
      foliage(ctx, w, h, inside, rnd, w + h);
      const { bloom, snow } = DRESS[season];
      const flowers = bloom ?? (snow ? [] : ['#ff9ec7']);
      for (let i = 0; i < (bloom ? 9 : 5) * A; i++) {
        const x = Math.floor(rnd() * w);
        const y = Math.floor(rnd() * h);
        if (flowers.length && inside(x, y) && inside(x + A, y + A)) rect(ctx, pick(flowers, rnd), x, y, A, A);
      }
    }, again);
  }

  /** Grass, flowers and paths, in the season's colours, with snow on them in winter. */
  function groundTiles(again = false) {
    const d = DRESS[season];
    const rnd = mulberry32(1234 + A);
    const tufts = (ctx: Ctx) => {
      for (let i = 0; i < 9; i++) {
        let x = 0;
        let y = 0;
        do { x = 2 + Math.floor(rnd() * (TW - 4)); y = 2 + Math.floor(rnd() * (TH - 4)); } while (!insideTile(x, y));
        rect(ctx, d.tuft[0], x, y, 1, 1); rect(ctx, d.tuft[1], x + 1, y - 1, 1, 1); rect(ctx, d.tuft[0], x + 2, y, 1, 1);
      }
    };
    d.grass.forEach((g, i) => tileTex(names.tile(`grass${i}` as 'grass0'), g, d.speck, d.lip, rnd, tufts, undefined, again));
    tileTex(names.tile('flowers'), d.grass[0] as string, d.speck, d.lip, rnd, (ctx) => {
      tufts(ctx);
      for (let i = 0; i < 5; i++) {
        let x = 0;
        let y = 0;
        do { x = Math.floor(rnd() * TW); y = Math.floor(rnd() * TH); } while (!insideTile(x, y) || !insideTile(x + A, y + A));
        rect(ctx, pick(d.flowers, rnd), x, y, 2, 2); rect(ctx, '#ffd34d', x, y, 1, 1); rect(ctx, '#2f6e27', x + 1, y + 2, 1, 1);
      }
    }, undefined, again);
    const pathRnd = mulberry32(4321 + A);
    tileTex(names.tile('path'), C.dirt, d.pathSpeck, C.dirtLip, pathRnd, (ctx) => {
      for (let i = 0; i < 8; i++) {
        const x = Math.floor(pathRnd() * TW);
        const y = Math.floor(pathRnd() * TH);
        if (insideTile(x, y) && insideTile(x + 2, y + 1)) { rect(ctx, '#c49866', x, y, 2, 1); rect(ctx, '#6e4a2a', x, y + 1, 2, 1); }
      }
    }, undefined, again);
  }

  // Night and the seasons (decision 62): the glow of a light, banded like the nebulae, a jack-o'-lantern,
  // a snowman, snowflakes, leaves and petals to fall, Mira the star, and the z's of a sleeping mirling.
  function nightAndSeasons() {
    for (const [kind, rgb] of [['warm', '255,214,140'], ['fire', '255,150,60']] as const) {
      canvasTex(names.glow(kind), 64, 64, (ctx) => {
        for (const [r, a] of [[32, 0.06], [26, 0.1], [20, 0.16], [14, 0.24], [8, 0.34]] as Array<[number, number]>) {
          ctx.fillStyle = `rgba(${rgb},${a})`;
          for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (Math.hypot(x + 0.5 - 32, (y + 0.5 - 32) * 1.6) <= r) ctx.fillRect(x, y, 1, 1);
        }
      });
    }
    pixelMap(names.seasonal('pumpkin'), MAPS.pumpkin, { o: '#7a2e0b', O: '#ff8a3d', d: '#d9601f', Y: '#ffe08a', b: '#4a6b2a', g: '#6fa83a' });
    pixelMap(names.seasonal('snowman'), MAPS.snowman, { o: '#5a6a85', W: SNOW, S: '#c3cfdf', K: '#2a2f45', e: '#1b1420', N: '#ff8a3d', R: '#e04b3a', b: '#2a2f45' });
    canvasTex(names.flake('snow'), 2, 2, (ctx) => rect(ctx, SNOW, 0, 0, 2, 2));
    canvasTex(names.flake('leaf'), 3, 2, (ctx) => { rect(ctx, '#e07a2a', 0, 0, 3, 2); rect(ctx, '#f2b03a', 0, 0, 1, 1); });
    canvasTex(names.flake('petal'), 2, 2, (ctx) => { rect(ctx, '#ffc4dc', 0, 0, 2, 2); rect(ctx, '#fff0f5', 0, 0, 1, 1); });
    pixelMap(names.star, MAPS.star, { a: '#ff8a5a', r: '#ffb38a', c: '#ffe0c8', W: '#ffffff' });
    pixelMap(names.zzz, MAPS.zzz, { z: '#e8ecff' });
  }

  // Wildlife (decision 63), and clouds to drift under the island: overlapping puffs, lit from above.
  function wildlife() {
    for (const frame of ['a', 'b'] as const) {
      pixelMap(names.bird(frame), MAPS.bird[frame], { o: '#2a2f45', w: '#f4f1e6' });
      pixelMap(names.butterfly(frame), MAPS.butterfly[frame], { w: '#ffffff', W: '#d8d8e8', b: '#2a2f45' });
    }
    pixelMap(names.fish, MAPS.fish, { o: '#c25a1f', O: '#ff9a4d' });
    MAPS.splash.forEach((rows, frame) => pixelMap(names.splash(frame), rows, { w: '#cfe8ff' }));
    pixelMap(names.firefly, ['.y.', 'yWy', '.y.'], { y: '#d9f27a', W: '#fff7a8' });
    // Drawn three times the size of the puffs below, so a cloud's pixels match the island's.
    const puffs: Array<Array<[number, number, number]>> = ([
      [[10, 9, 6], [20, 7, 8], [31, 9, 6], [16, 11, 5], [26, 11, 5]],
      [[9, 11, 6], [19, 8, 8], [30, 7, 9], [41, 10, 7], [24, 12, 6], [35, 12, 5]],
      [[8, 7, 5], [16, 5, 6], [23, 7, 5]],
    ] as Array<Array<[number, number, number]>>).map((circles) => circles.map(([x, y, r]) => [x * 3, y * 3, r * 3] as [number, number, number]));
    puffs.forEach((circles, i) => {
      const w = Math.max(...circles.map(([x, , r]) => x + r)) + 2;
      const h = Math.max(...circles.map(([, y, r]) => y + r)) + 1;
      const inside = (x: number, y: number) => circles.some(([cx, cy, r]) => Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) * 1.3) <= r);
      canvasTex(names.cloud(i), w, h, (ctx) => {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!inside(x, y)) continue;
            rect(ctx, !inside(x, y + 2) || !inside(x, y + 4) ? '#c9d2e6' : !inside(x, y - 2) ? '#ffffff' : '#eef1f8', x, y, 1, 1);
          }
        }
      });
    });
  }

  function isoBlock(ctx: Ctx, cx: number, gy: number, hw: number, wallH: number, left: string, right: string, top: string) {
    const bottoms = bottomsFor(cx, gy, hw);
    for (let x = cx - hw; x < cx + hw; x++) rect(ctx, x < cx ? left : right, x, (bottoms[x] ?? 0) - wallH + 1, 1, wallH);
    diamond(ctx, top, cx, gy - wallH, hw);
  }

  // Build mode's plants and decorations (decision 39), from the sky mockup.
  function decorations() {
    shrub();

    const bedRnd = mulberry32(31 + A);
    const hw = 12 * A;
    const wallH = 3 * A;
    const bedW = hw * 2 + 2;
    const bedH = hw + wallH + 4 * A;
    anchors.set(names.item('flowerbed'), { ox: (hw + 1) / bedW, oy: (bedH - hw / 2) / bedH, height: bedH - hw / 2 });
    canvasTex(names.item('flowerbed'), bedW, bedH, (ctx) => {
      const cx = hw + 1;
      const gy = bedH - hw / 2;
      isoBlock(ctx, cx, gy, hw, wallH, '#8a5a32', '#6b4423', '#4a2e1c');
      for (let i = 0; i < 16 * A; i++) {
        const x = Math.floor(bedRnd() * hw * 2) - hw;
        const y = Math.floor(bedRnd() * hw) - hw / 2;
        if (Math.abs(x + 0.5) / hw + Math.abs(y + 0.5) / (hw / 2) > 0.7) continue;
        rect(ctx, '#3f8530', cx + x, gy - wallH + y + A, A, A);
        rect(ctx, pick(C.flowers, bedRnd), cx + x, gy - wallH + y, A, A);
      }
    });

    canvasTex(names.item('lamp'), 6 * A, 20 * A, (ctx) => {
      const h = 20 * A;
      rect(ctx, 'rgba(255,224,138,0.22)', 0, A, 6 * A, 6 * A);
      rect(ctx, '#2a2f45', A, A, 4 * A, A);
      rect(ctx, '#2a2f45', A, 2 * A, 4 * A, 4 * A);
      rect(ctx, '#ffe08a', 2 * A, 3 * A, 2 * A, 2 * A);
      rect(ctx, '#2a2f45', 3 * A - Math.floor(A / 2), 6 * A, A, h - 8 * A);
      rect(ctx, '#2a2f45', 2 * A, h - 2 * A, 2 * A, 2 * A);
    });

    canvasTex(names.item('bench'), 14 * A, 14 * A, (ctx) => {
      const len = 12 * A;
      const y0 = 5 * A;
      for (let x = 0; x < len; x++) {
        const y = y0 + Math.floor(x / 2);
        rect(ctx, '#8a5a32', x + A, y - 3 * A, 1, A);
        rect(ctx, '#c48a58', x + A, y, 1, A);
        rect(ctx, '#8a5a32', x + A, y + A, 1, A);
      }
      for (const x of [A, len - A]) {
        const y = y0 + Math.floor((x - A) / 2);
        rect(ctx, '#4a2e1c', x, y + 2 * A, A, 2 * A);
        rect(ctx, '#4a2e1c', x, y - 3 * A, A, 3 * A);
      }
    });

    // A golden mirling on a stone plinth.
    const map = MAPS.creature.a;
    const cw = map[0]?.length ?? 18;
    const ch = map.length;
    const phw = 8 * A;
    const plinth = 7 * A;
    const sw = Math.max(phw * 2 + 2, cw + 2);
    const sh = ch + plinth + phw + 2 * A;
    const gold: Record<string, string> = { o: '#6b4a12', y: '#ffcf3f', h: '#fff3b0', s: '#d9a21f', d: '#b07d12', e: '#6b4a12', w: '#fff3b0', m: '#6b4a12', k: '#ffcf3f', f: '#6b4a12' };
    anchors.set(names.item('statue'), { ox: Math.floor(sw / 2) / sw, oy: (sh - phw / 2) / sh, height: sh - phw / 2 });
    canvasTex(names.item('statue'), sw, sh, (ctx) => {
      const cx = Math.floor(sw / 2);
      const gy = sh - phw / 2;
      isoBlock(ctx, cx, gy, phw, plinth, '#c9cbd6', '#9ea1ae', '#e2e4ec');
      const top = gy - plinth - Math.floor(phw / 4) - ch + A;
      map.forEach((row, y) => [...row].forEach((c, x) => { const color = gold[c]; if (color) rect(ctx, color, cx - Math.floor(cw / 2) + x, top + y, 1, 1); }));
    });

    for (const ok of [true, false]) {
      const color = ok ? '#7bd389' : '#ff6b7a';
      canvasTex(names.cursor(ok), TW, TH, (ctx) => {
        const half = TW / 2;
        const hh = TH / 2;
        diamond(ctx, `${color}55`, half, hh, half);
        for (let i = 0; i < hh; i++) {
          const up = (i + 1) * 2;
          const down = half - i * 2;
          rect(ctx, color, half - up, i, A + 1, 1); rect(ctx, color, half + up - A - 1, i, A + 1, 1);
          rect(ctx, color, half - down, hh + i, A + 1, 1); rect(ctx, color, half + down - A - 1, hh + i, A + 1, 1);
        }
      });
    }
  }

  /** Paints every pixel of a shape: its outline in `edge`, the rest from `fill`. */
  function blob(ctx: Ctx, w: number, h: number, inside: (x: number, y: number) => boolean, fill: (x: number, y: number) => string, edge: string) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside(x, y)) continue;
        rect(ctx, !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1) ? edge : fill(x, y), x, y, 1, 1);
      }
    }
  }

  // More to place anywhere on the island, and on its water (decision 44).
  function outdoors() {
    pine();

    canvasTex(names.item('sunflowers'), 16, 24, (ctx) => {
      for (const [x, top] of [[3, 9], [8, 4], [13, 8]] as Array<[number, number]>) {
        rect(ctx, '#3f8530', x, top + 2, 1, 24 - top - 2);
        rect(ctx, '#4f9a3c', x - 2, top + 8, 2, 1);
        rect(ctx, '#4f9a3c', x + 1, top + 11, 2, 1);
        const head = (px: number, py: number) => Math.hypot(px + 0.5 - (x + 0.5), py + 0.5 - (top + 1.5)) <= 3;
        blob(ctx, 16, 24, head, (px, py) => (Math.hypot(px - x, py - top - 1) <= 1.2 ? '#6b4423' : px + py < x + top + 1 ? '#ffe08a' : '#ffcf3f'), '#b07d12');
      }
    });

    canvasTex(names.item('mushrooms'), 16, 12, (ctx) => {
      for (const [cx, capY, r] of [[10, 4, 4], [4, 6, 3], [13, 8, 2.5]] as Array<[number, number, number]>) {
        rect(ctx, '#efe6d2', cx - 1, capY, 2, 11 - capY);
        rect(ctx, '#cfc3a8', cx, capY, 1, 11 - capY);
        const cap = (x: number, y: number) => y <= capY && ((x + 0.5 - cx) / r) ** 2 + ((y + 0.5 - capY) / (r * 0.85)) ** 2 <= 1;
        blob(ctx, 16, 12, cap, (x, y) => (noise(x, y) < 0.18 ? '#fff7ec' : '#e04b3a'), '#7a2018');
      }
    });

    const rockRnd = mulberry32(17);
    canvasTex(names.item('rock'), 22, 14, (ctx) => {
      const inside = (x: number, y: number) => ((x + 0.5 - 11) / 10) ** 2 + ((y + 0.5 - 8.5) / 5.5) ** 2 <= 1 || ((x + 0.5 - 14) / 5.5) ** 2 + ((y + 0.5 - 5.5) / 4.5) ** 2 <= 1;
      blob(ctx, 22, 14, inside, (x, y) => {
        if (y < 6 && rockRnd() < 0.35) return '#5aad46';
        const light = (x + y) / 36 + rockRnd() * 0.1;
        return light < 0.35 ? '#b4b5c0' : light < 0.6 ? '#8e8f9a' : '#6a6b76';
      }, '#3b3b45');
    });

    // Two crates, a small one on a big one.
    const crate = { hw: 5 * A, wall: 7 * A, small: 3.5 * A, smallWall: 5 * A };
    const crateW = crate.hw * 2 + 2;
    const crateH = crate.wall + crate.smallWall + crate.hw + 2;
    anchors.set(names.item('crates'), { ox: (crate.hw + 1) / crateW, oy: (crateH - crate.hw / 2 - 1) / crateH, height: crateH - crate.hw / 2 - 1 });
    canvasTex(names.item('crates'), crateW, crateH, (ctx) => {
      const cx = crate.hw + 1;
      const gy = crateH - crate.hw / 2 - 1;
      for (const [hw, wall, y] of [[crate.hw, crate.wall, gy], [crate.small, crate.smallWall, gy - crate.wall]] as Array<[number, number, number]>) {
        isoBlock(ctx, cx, y, hw, wall, '#a8744a', '#86592f', '#c48a58');
        const bottoms = bottomsFor(cx, y, hw);
        for (let x = cx - hw; x < cx + hw; x++) rect(ctx, '#6b4423', x, (bottoms[x] ?? 0) - Math.floor(wall / 2), 1, 1);
        rect(ctx, '#6b4423', cx, y - wall - hw / 2 + 1, 1, hw);
      }
    });

    // A stone well with a little roof and a bucket.
    const well = { hw: 7 * A, wall: 5 * A, post: 15 * A, roof: 5 * A };
    const wellW = well.hw * 2 + 2;
    const wellH = well.hw / 2 + 2 + well.wall + well.post + well.roof + 1;
    const wellGy = wellH - well.hw / 2 - 1;
    const roofTop = wellGy - well.wall - well.post - well.roof;
    anchors.set(names.item('well'), { ox: (well.hw + 1) / wellW, oy: wellGy / wellH, height: wellGy - roofTop });
    canvasTex(names.item('well'), wellW, wellH, (ctx) => {
      const cx = well.hw + 1;
      const top = wellGy - well.wall;
      const postTop = top - well.post;
      isoBlock(ctx, cx, wellGy, well.hw, well.wall, '#9ea1ae', '#7d808c', '#c9cbd6');
      diamond(ctx, '#2c5ea0', cx, top, well.hw - 2 * A);
      diamond(ctx, '#3d7fd1', cx, top + A, well.hw - 4 * A);
      for (const x of [cx - well.hw + A, cx + well.hw - 2 * A]) rect(ctx, '#6b4423', x, postTop, A, well.post + A);
      rect(ctx, '#4a2e1c', cx - well.hw + 2 * A, postTop + 3 * A, well.hw * 2 - 4 * A, A);
      rect(ctx, '#d0c8b0', cx, postTop + 4 * A, 1, 5 * A);
      rect(ctx, '#8a5a32', cx - A, postTop + 9 * A, 2 * A + 1, 2 * A);
      for (let i = 0; i < well.roof; i++) {
        const half = Math.round(((i + 1) / well.roof) * (well.hw + A));
        rect(ctx, i === well.roof - 1 ? '#7a2018' : i % 3 === 0 ? '#c4473a' : '#a83a2c', cx - half, roofTop + i, half * 2, 1);
      }
    });

    canvasTex(names.item('campfire'), 20, 22, (ctx) => {
      blob(ctx, 20, 22, (x, y) => ((x + 0.5 - 10) / 9.5) ** 2 + ((y + 0.5 - 12) / 10) ** 2 <= 1, () => 'rgba(255,170,60,0.16)', 'rgba(255,170,60,0.08)');
      for (let y = 0; y < 22; y++) {
        for (let x = 0; x < 20; x++) {
          const d = ((x + 0.5 - 10) / 8) ** 2 + ((y + 0.5 - 18.5) / 3.2) ** 2;
          if (d <= 1 && d >= 0.45) rect(ctx, (x + y) % 3 === 0 ? '#6f6f7a' : '#8e8e98', x, y, 1, 1);
        }
      }
      line(ctx, '#6b4423', 5, 19, 14, 15, 2);
      line(ctx, '#8a5a32', 6, 15, 15, 19, 2);
      const half = (y: number) => { const f = (y - 3) / 14; return f < 0 || f > 1 ? -1 : 5.5 * Math.sin(Math.PI * Math.min(f, 0.75) * 0.9) * Math.pow(f, 0.35); };
      for (const [scale, from, color] of [[1, 3, '#e04b3a'], [0.68, 7, '#ff8a3d'], [0.4, 10, '#ffd34d'], [0.18, 12, '#fff3b0']] as Array<[number, number, string]>) {
        for (let y = from; y <= 17; y++) for (let x = 0; x < 20; x++) if (Math.abs(x + 0.5 - 10) <= half(y) * scale) rect(ctx, color, x, y, 1, 1);
      }
    });

    // Lily pads lie flat on the water, centred on their tile.
    anchors.set(names.item('lilies'), { ox: 0.5, oy: 0.55, height: 0 });
    canvasTex(names.item('lilies'), 30, 14, (ctx) => {
      for (const [cx, cy, rx, ry] of [[8, 6, 5, 2.6], [19, 4, 4, 2.1], [21, 10, 5.5, 2.8], [10, 11, 3.5, 1.8]] as Array<[number, number, number, number]>) {
        const pad = (x: number, y: number) => {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1 && !(dx > 0 && Math.abs(dy) < dx * 0.35); // a notch on its right
        };
        blob(ctx, 30, 14, pad, (x, y) => (x - cx + (y - cy) * 2 < -1 ? '#6cc455' : '#4f9a3c'), '#2d6b2b');
      }
      rect(ctx, '#ff9ec7', 18, 9, 3, 2);
      rect(ctx, '#ffd0e4', 19, 8, 1, 1);
      rect(ctx, '#ffd34d', 19, 9, 1, 1);
    });

    // A rowing boat lying along the columns: its hull a lens on the ground's plane, its side below the rim.
    anchors.set(names.item('boat'), { ox: 0.5, oy: 10.5 / 24, height: 0 });
    canvasTex(names.item('boat'), 36, 24, (ctx) => {
      const lens = (x: number, y: number, down: number, a: number, b: number) => {
        const dx = x + 0.5 - 18;
        const dy = y + 0.5 - 10 - down;
        const along = dy + dx / 2;
        const across = dy - dx / 2;
        return Math.abs(along) <= a && Math.abs(across) <= b * (1 - (along / a) ** 2);
      };
      blob(ctx, 36, 24, (x, y) => lens(x, y, 5, 12, 4.5), () => 'rgba(20,40,80,0.35)', 'rgba(20,40,80,0.2)');
      blob(ctx, 36, 24, (x, y) => lens(x, y, 3, 12, 4.5) || lens(x, y, 1.5, 12, 4.5), (x) => (x < 18 ? '#6b4423' : '#55361d'), '#3a2414');
      blob(ctx, 36, 24, (x, y) => lens(x, y, 0, 12, 4.5), (x, y) => {
        if (!lens(x, y, 0, 10, 3)) return '#8a5a32';
        const dx = x + 0.5 - 18;
        const along = y + 0.5 - 10 + dx / 2;
        return Math.abs(along) < 1.2 ? '#6b4423' : '#c48a58';
      }, '#3a2414');
    });
  }

  function tiles() {
    const rnd = mulberry32(1234 + A);
    groundTiles();
    // No rim on top, so neighbouring water tiles run together into one stream or pond.
    tileTex(names.tile('water'), C.water, [C.water], C.waterRim, rnd, (ctx) => {
      for (const [x, y] of [[9, 7], [18, 5], [15, 10]] as Array<[number, number]>) rect(ctx, C.waterGlint, x * A, y * A, 2 * A, 1);
    });
    // A bridge's deck: eight planks laid across the way it's crossed (decision 42).
    for (const span of ['c', 'r'] as const) {
      tileTex(names.tile(`deck-${span}`), '#a8774a', ['#a8774a'], '#6b4a2e', rnd, (ctx) => {
        for (let y = 0; y < TH; y++) {
          for (let x = 0; x < TW; x++) {
            const u = (x + 0.5 - TW / 2) / (TW / 2);
            const v = (y + 0.5 - TH / 2) / (TH / 2);
            if (Math.abs(u) + Math.abs(v) > 1) continue;
            const t = ((span === 'c' ? u + v : v - u) + 1) * 4;
            rect(ctx, t - Math.floor(t) < 0.14 ? '#5e3e26' : Math.floor(t) % 2 ? '#b98957' : '#a8774a', x, y, 1, 1);
          }
        }
      }, ['#6b4423', '#4f311a']);
    }
  }

  function buildings() {
    const trim = '#e3c79d';
    const houseWalls = (lit: boolean) => (ctx: Ctx, cx: number, bottoms: number[], wallH: number, hw: number) => {
      const door = cx - Math.round(hw * 0.55);
      const dw = 3 * A;
      const dh = 5 * A;
      for (let x = door; x < door + dw; x++) rect(ctx, '#3a2418', x, (bottoms[x] ?? 0) - dh, 1, dh);
      for (let x = door - 1; x <= door + dw; x++) rect(ctx, trim, x, (bottoms[x] ?? 0) - dh - 1, 1, 1);
      rect(ctx, trim, door - 1, (bottoms[door - 1] ?? 0) - dh, 1, dh);
      rect(ctx, '#ffd34d', door + dw - 2, (bottoms[door + dw - 2] ?? 0) - 3 * A, 1, 1);
      const glass = lit ? '#ffe08a' : '#2a2f45';
      for (const start of [cx + 3 * A, cx + hw - 5 * A]) {
        for (let x = start; x < start + 2 * A; x++) {
          const y = (bottoms[x] ?? 0) - wallH + 3 * A;
          rect(ctx, glass, x, y, 1, 2 * A);
          rect(ctx, trim, x, y - 1, 1, 1);
          rect(ctx, trim, x, y + 2 * A, 1, 1);
        }
        rect(ctx, trim, start + A, (bottoms[start + A] ?? 0) - wallH + 3 * A, 1, 2 * A);
      }
    };
    const chimney = (ctx: Ctx, cx: number, topY: number, roofH: number) => {
      const y = Math.round(topY - roofH * 0.5) - 4 * A;
      rect(ctx, '#7a3a2a', cx + 4 * A, y, 2 * A, 5 * A);
      rect(ctx, '#4a2418', cx + 4 * A, y, 2 * A, 1);
    };
    const houseStyles: Record<HouseStyle, Pick<BuildingSpec, 'texture' | 'wallL' | 'wallR' | 'roofL' | 'roofR' | 'eave'>> = {
      brick: { texture: 'brick', wallL: '#b5523b', wallR: '#8e3d2c', roofL: '#55658a', roofR: '#3d4a68', eave: '#262f45' },
      timber: { texture: 'timber', wallL: '#eadfc4', wallR: '#c9bb98', roofL: '#c0563c', roofR: '#94402c', eave: '#5e2416' },
      stone: { texture: 'stone', wallL: '#aeb0bb', wallR: '#878995', roofL: '#3f8f86', roofR: '#2f6e67', eave: '#1f4d48' },
    };
    for (const [style, colors] of Object.entries(houseStyles) as Array<[HouseStyle, typeof houseStyles.brick]>) {
      for (const lit of [true, false]) building(names.house(style, lit), { hw: 12, wallH: 9, roofH: 8, extraTop: 4, extras: chimney, ...colors, walls: houseWalls(lit) });
    }

    for (let level = 1; level <= MAX_LEVEL; level++) {
      building(names.building('library', level), {
        hw: 14, wallH: 10 + (level - 1) * 6, texture: 'stone', wallL: '#d9cdb0', wallR: '#b3a688', top: '#5d7fb8', topInner: '#4a6699',
        walls: (ctx, cx, bottoms) => {
          for (let x = cx - 12 * A; x < cx + 12 * A; x++) {
            if ((x - cx + 12 * A) % (3 * A) >= A || Math.abs(x + 0.5 - cx) < A) continue;
            for (let f = 0; f < level; f++) rect(ctx, f % 2 ? '#ffe08a' : '#7d93c4', x, (bottoms[x] ?? 0) - 4 * A - f * 6 * A, 1, 2 * A);
          }
        },
      });
      building(names.building('workshop', level), {
        hw: 14, wallH: 8 + (level - 1) * 4, roofH: 7 + level, extraTop: 8, texture: 'planks',
        wallL: '#a8744a', wallR: '#7f5636', roofL: '#e07a3f', roofR: '#b85d2c', eave: '#7a3a1a',
        walls: (ctx, cx, bottoms) => {
          for (let x = cx - 9 * A; x < cx - 5 * A; x++) rect(ctx, (x - cx) % 2 ? '#3a2416' : '#4a2e1c', x, (bottoms[x] ?? 0) - 6 * A, 1, 6 * A);
          for (let x = cx + 5 * A; x < cx + 7 * A; x++) rect(ctx, '#ffe08a', x, (bottoms[x] ?? 0) - 6 * A, 1, 2 * A);
        },
        extras: (ctx, cx, topY, roofH) => {
          const y = Math.round(topY - roofH * 0.45) - 6 * A;
          rect(ctx, '#5e3e26', cx + 4 * A, y, 3 * A, 7 * A);
          rect(ctx, '#3b2a2a', cx + 4 * A, y, 3 * A, A);
        },
      });
    }
  }

  return {
    scale: A,
    tile: { w: TW, h: TH, side: SIDE },
    sizes: { creature: MAPS.creature.a.length, beacon: MAPS.beacon.length, bubble: MAPS.bubble.length, thought: MAPS.thought.length },
    playground: PLAYGROUND,
    lights: { lamp: { x: 0, y: -14 * A }, campfire: { x: 0, y: -2 * A }, house: { x: 0, y: -9 * A }, pumpkin: { x: 0, y: -3 * A }, workshop: { x: 0, y: -10 * A }, library: { x: 0, y: -10 * A } },

    create(s, dressedFor) {
      scene = s;
      season = dressedFor;
      if (scene.textures.exists(names.tile('grass0'))) return;
      tiles();
      for (const palette of Object.keys(PAL) as Palette[]) {
        for (const frame of ['a', 'b'] as const) {
          pixelMap(names.creature(palette, frame), MAPS.creature[frame], PAL[palette]);
          pixelMap(names.helper(palette, frame), MAPS.helper[frame], PAL[palette]);
        }
        pixelMap(names.creature(palette, 'asleep'), ASLEEP, PAL[palette]);
      }
      tree(names.tree(false), false);
      tree(names.tree(true), true);
      pixelMap(names.beacon, MAPS.beacon, { o: '#7a2e0b', O: '#ff8a3d', h: '#ffc38f', w: '#fff7ec' });
      pixelMap(names.bubble, MAPS.bubble, { o: '#2a2f45', W: '#f4f1e6', d: '#5a5f7a' });
      pixelMap(names.smoke, MAPS.smoke, { g: '#5f5f68', G: '#8b8b95', h: '#b4b4bd' });
      canvasTex(names.select, 16 * A, 8 * A, (ctx) => {
        const hw = 8 * A;
        const hh = 4 * A;
        for (let i = 0; i < hh; i++) {
          const up = (i + 1) * 2;
          const down = hw - i * 2;
          rect(ctx, '#ffd34d', hw - up, i, A + 1, 1); rect(ctx, '#ffd34d', hw + up - A - 1, i, A + 1, 1);
          rect(ctx, '#ffd34d', hw - down, hh + i, A + 1, 1); rect(ctx, '#ffd34d', hw + down - A - 1, hh + i, A + 1, 1);
        }
      });
      buildings();
      decorations();
      outdoors();
      waterworks();
      playground();
      ring();
      props();
      nightAndSeasons();
      wildlife();
    },

    dress(s, next) {
      scene = s;
      if (next === season) return;
      season = next;
      groundTiles(true);
      tree(names.tree(false), false, true);
      tree(names.tree(true), true, true);
      pine(true);
      shrub(true);
    },

    anchor(key) {
      return anchors.get(key) ?? { ox: 0.5, oy: 1, height: 0 };
    },

    underside(s, columns, key) {
      scene = s;
      const depth = 96 * A;
      const xs = [...columns.keys()];
      const ys = [...columns.values()];
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const half = (maxX - minX) / 2 || 1;
      const mid = minX + half;
      const rnd = mulberry32(xs.length * 31 + A);
      const noise = Array.from({ length: Math.ceil((maxX - minX + 1) / (4 * A)) + 1 }, () => rnd());
      canvasTex(key, maxX - minX + 1, maxY - minY + depth + 4, (ctx) => {
        for (let X = minX; X <= maxX; X++) {
          const top = columns.get(X);
          if (top === undefined) continue;
          const t = Math.abs(X - mid) / half;
          let d = depth * Math.pow(Math.max(0, 1 - t), 1.3) * (0.72 + (noise[Math.floor((X - minX) / (4 * A))] ?? 0) * 0.45);
          d = Math.max(2 * A, Math.round(d / (3 * A)) * 3 * A);
          const y0 = top - minY + 1;
          for (let k = 0; k < d; k++) {
            const color = k < 2 * A ? C.strata : k > d - 4 * A ? C.rockDeep : (C.rock[Math.floor(k / (5 * A)) % 2] as string);
            rect(ctx, color, X - minX, y0 + k, 1, 1);
          }
          if (d > 16 * A && rnd() < 0.05 / A) rect(ctx, pick(C.crystal, rnd), X - minX, y0 + 4 * A + Math.floor(rnd() * (d - 10 * A)), A, 2 * A);
        }
      });
    },
  };
}
