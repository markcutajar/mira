// The sky: one island, a section per project with streams between, and a mirling per live session
// acting out what it's doing (decisions 12, 13, 41 and 42). Sessions come from the hub; nothing here
// is simulated.

import type { MiraEvent } from '../../../contracts/src/index.ts';
import { sessionLabel, type BoardSession } from '../shared/format.ts';
import { ACCENT_COLOUR, ACCENTS, MAX_LEVEL, names, WATERFALL_FRAMES, type Accent, type Art, type Decoration, type Edge, type HouseStyle, type Palette } from './art.ts';
import { arrange, BUILDING_LABEL, destinations, edit, isItem, isPiece, ITEMS, move, movePiece, onWater, pieceAt, PIECES, placeOf, restyle, sameLayouts, unreachable, type ItemKind, type Outcome, type PieceKind, type Placed, type SectionLayout, type Tool, type Where } from './build.ts';
import { findPath, generateCells, hash, SEC, sectionOrigin, spotsAround, type BuildingType, type Cell, type Spot, type Template } from './world.ts';

type Status = 'working' | 'needs-me' | 'my-turn' | 'failed' | 'ended';
type Image = Phaser.GameObjects.Image;
type Text = Phaser.GameObjects.Text;

interface Building extends Spot {
  id: string;
  type: BuildingType;
  x: number;
  y: number;
  top: number;
  img: Image;
  spots: Spot[];
  door: Spot;
  style: HouseStyle;
  residents: number;
  /** Workshops and libraries grow with the project's commits (decision 35); 1 to MAX_LEVEL. */
  level: number;
}

interface Section {
  i: number;
  name: string;
  accent: Accent;
  template: Template;
  buildings: Building[];
  houses: Building[];
  anchor: { x: number; y: number };
  label: Text;
  summary: Text;
  /** The latest commit counts, once the hub has sent them. */
  growth?: SectionGrowth;
  play: Playground;
}

type SwingSet = Spot & { x: number; y: number; ropes: Phaser.GameObjects.Graphics; seats: Array<Mirling | null> };
/** A slide or a trampoline, and who's on it. */
type Ride = Spot & { x: number; y: number; users: Set<Mirling> };

/** Where a section's mirlings wait for me (decisions 41 and 49): its swings, slides and trampolines, however many I've put up, and its pond. */
interface Playground {
  swings: SwingSet[];
  slides: Ride[];
  trampolines: Ride[];
  pond: Spot[];
  floating: Set<Mirling>;
}

/** What a mirling does while it works: reads at the library, makes at the workshop, runs commands there, or thinks on its feet. */
type Act = 'read' | 'make' | 'run' | 'think';

type Play =
  | { kind: 'swing'; frame: SwingSet; seat: number; seated: boolean; from: number; swing: { amp: number } }
  | { kind: 'slide'; ride: Ride }
  | { kind: 'bounce'; ride: Ride; spot: number }
  | { kind: 'float'; back: Image; front: Image };

/** A project's recent commits and the building levels they earn, as the hub sends them. */
export interface SectionGrowth {
  commits: number;
  docs: number;
  workshop: number;
  library: number;
}

interface Helper {
  pos: { x: number; y: number };
  off: { x: number; y: number };
  phase: number;
  sprite: Image;
}

interface Mirling {
  id: string;
  title: string;
  /** Its own name (decision 48), on the tag over its head. */
  name: string;
  tag: Text;
  sec: Section;
  home: Building;
  work: Building;
  cell: Spot;
  pos: { x: number; y: number };
  sprite: Image;
  status: Status | null;
  /** Its own colour, and the one it shows now: grey while failed. */
  base: Palette;
  palette: Palette;
  walkId: number;
  moving: boolean;
  facing: 1 | -1;
  phase: number;
  marks: { beacon?: { img: Image; ring: Phaser.GameObjects.Arc; pulse: { t: number } }; bubble?: Image; smoke?: Phaser.Time.TimerEvent };
  helpers: Map<string, Helper>;
  removed: boolean;
  /** The tool running now, from its start to its finish, and what that has the mirling doing. */
  tool: string | null;
  act: Act | null;
  /** What it holds while it works, or the bubble over it while it thinks. */
  gear: { prop?: Image; thought?: Image; swing?: { t: number } };
  /** Where it's playing while it waits for me. */
  play: Play | null;
  /** Up on a swing, the slide or a ring, off the tiles it walks; it hops back down to `cell` before walking on. */
  aloft: boolean;
  /** Drawn at this depth instead of its own while on the playground. */
  depth?: number;
  /** Tweens and timers of what it's doing now, stopped when that changes. */
  later: Array<{ remove(): unknown }>;
  /** Waiting to see whether a finished tool is followed by another or by thinking. */
  pause?: Phaser.Time.TimerEvent;
}

export interface SkyOptions {
  art: Art;
  /**
   * Space the page covers on each side, in CSS pixels: the top and bottom bars, the side panel on
   * the left, and the story on the right while it's open. The camera works in the clear space between.
   */
  insets(): { top: number; bottom: number; left: number; right: number };
  /** A mirling was clicked. */
  onSelect(id: string): void;
  /** A section's name was clicked. */
  onSection?(name: string): void;
  /** The zoom level changed: its name, and whether it can go closer or further. */
  onZoom?(name: string, closer: boolean, further: boolean): void;
  /** I changed a project's layout in build mode (decision 39). */
  onLayout?(name: string, layout: SectionLayout): void;
  /** What build mode has to say: what the tool does, or why a click didn't work. */
  onBuildHint?(text: string): void;
}

/** A tile of the island as build mode sees it: whose layout it's in, and where. */
interface Target {
  sec: Section;
  where: Where;
  cell: Cell;
  building?: Building;
  piece?: PieceKind;
}

/** A play piece picked up in build mode, to put down somewhere else in its layout. */
interface PickedPiece {
  piece: PieceKind;
  c: number;
  r: number;
  where: Where;
}

// Where a placed picture stands on its tile, in art pixels below the tile's centre. Lily pads lie
// flat on the water, under anything that floats by.
const ITEM_DROP: Partial<Record<ItemKind, number>> = { tree: 3, 'tree-apple': 3, pine: 3, shrub: 2, lamp: 2, bench: 3, sunflowers: 2, mushrooms: 2, rock: 2, campfire: 2 };
const FLAT = new Set<ItemKind>(['lilies']);
const buildingIndex = (b: Building) => Number(b.id.split(':')[1]);

// Tools that read go to the library with a book; edits are hammered out at the workshop, and other
// commands run at a console there. Between tools, and while subagents work, a mirling thinks on its feet.
const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead']);
const MAKING = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DIRECTING = new Set(['Task', 'Agent']);
const actFor = (tool: string | null): Act => (!tool || DIRECTING.has(tool) ? 'think' : READING.has(tool) ? 'read' : MAKING.has(tool) ? 'make' : 'run');
// A pause this long after a tool finishes, with no other started, is thinking.
const THINK_AFTER_MS = 1500;
const POND_FLOATERS = 5;
// Water lies this many art pixels below the ground, so streams and ponds have banks.
const WATER_DROP = 3;
const SLIDERS = 2;
/** How many mirlings bounce on one trampoline at once. */
const JUMPERS = 2;
const DPR = () => Math.min(window.devicePixelRatio || 1, 3);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pickOne = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)] as T;

export class SkyScene extends Phaser.Scene {
  #options: SkyOptions;
  #art: Art;
  #ready = false;
  #pending: { sessions: BoardSession[]; systems: string[]; labels: Record<string, string>; growth: Record<string, SectionGrowth> } | null = null;
  /** Projects I removed, taken off the island once the hub confirms they're gone. */
  #order: string[] = [];
  #templates = new Map<string, Template>();
  #sections: Section[] = [];
  #mirlings = new Map<string, Mirling>();
  #cells = new Map<string, Cell>();
  #ground: Phaser.GameObjects.GameObject[] = [];
  /** Water pouring off the island's front edges, and which edge each hangs from. */
  #falls: Array<{ img: Image; edge: 'se' | 'sw' }> = [];
  #artKeys = new Set<string>();
  #selected: string | null = null;
  #selectMark!: Image;
  #hoverLabel!: Text;
  #hovered: string | null = null;
  #hoveredBuilding: Building | null = null;
  #fit = { x: 0, y: 0, w: 1, h: 1 };
  #levels: Array<{ name: string; zoom: number }> = [{ name: 'Everything', zoom: 1 }];
  #zoomIdx = 0;
  #filter: Phaser.Textures.FilterMode | null = null;
  #drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null;
  #lastWheel = 0;
  #needsIdx = -1;
  /** How I arranged each project's section, and where its buildings stand as a result (decision 39). */
  #layouts: Record<string, SectionLayout> = {};
  #placements = new Map<string, Placed[]>();
  #build: { on: boolean; tool: Tool; picked: Building | PickedPiece | null } = { on: false, tool: 'tree', picked: null };
  /** Each play piece's picture, by tile, to light up the one picked up. */
  #pieceImages = new Map<string, Image>();
  #undo: Array<{ name: string; layout: SectionLayout | undefined }> = [];
  #cursor!: Image;
  #ghost!: Image;

  constructor(options: SkyOptions) {
    super({ key: 'sky' });
    this.#options = options;
    this.#art = options.art;
  }

  // -- the page's side --

  /** The latest sessions, the projects in the order they first appeared, and my names for them. Safe to call before the scene starts. */
  sync(sessions: BoardSession[], systems: string[], labels: Record<string, string> = {}, growth: Record<string, SectionGrowth> = {}): void {
    this.#pending = { sessions, systems, labels, growth };
    if (this.#ready) this.#apply();
  }

  /** Sets a mirling to the tool it just started, or to thinking once its tool has finished (decision 41). */
  event(e: MiraEvent): void {
    if (!this.#ready || e.actor.kind !== 'session') return;
    const col = this.#mirlings.get(e.actor.id);
    if (!col || col.removed) return;
    if (e.type === 'tool.started' && e.detail?.tool) {
      col.tool = e.detail.tool;
      col.pause?.remove();
      this.#floatText(col, e.detail.tool);
      if (col.status === 'working') this.#work(col);
    } else if (e.type === 'tool.finished' || e.type === 'tool.failed' || e.type === 'prompt.submitted') {
      col.tool = null;
      col.pause?.remove();
      col.pause = this.time.delayedCall(THINK_AFTER_MS, () => {
        if (col.status === 'working' && !col.tool && !col.removed) this.#work(col);
      });
    }
  }

  /** Marks the mirling whose story is open, or none. */
  select(id: string | null): void {
    this.#selected = id;
    if (this.#ready) this.#selectMark.setVisible(Boolean(id && this.#mirlings.has(id)));
  }

  /** Slides the camera so a mirling hidden behind the page's panels comes into the clear. */
  reveal(id: string): void {
    const col = this.#ready ? this.#mirlings.get(id) : undefined;
    if (!col) return;
    const cam = this.cameras.main;
    const d = DPR();
    const x = ((col.pos.x - cam.worldView.x) * cam.zoom) / d;
    const y = ((col.pos.y - cam.worldView.y) * cam.zoom) / d;
    const { top, bottom, left, right } = this.#options.insets();
    if (x > left + 40 && x < window.innerWidth - right - 40 && y > top + 40 && y < window.innerHeight - bottom - 20) return;
    const c = this.#centerFor(col.pos, cam.zoom);
    cam.pan(c.x, c.y, 400, 'Sine.easeInOut', true);
  }

  /** Flies to a session's mirling, close enough to see it; false if it has none on the island. */
  focusSession(id: string): boolean {
    const col = this.#ready ? this.#mirlings.get(id) : undefined;
    if (!col) return false;
    const section = this.#levels.findIndex((l) => l.name === 'Section');
    this.#setZoom(Math.max(this.#zoomIdx, section), col.pos);
    return true;
  }

  /** Flies to a project's section. */
  focusSection(name: string): void {
    const i = this.#order.indexOf(name);
    if (!this.#ready || i < 0 || !this.#sections[i]) return;
    const { c0, r0 } = sectionOrigin(i);
    const section = this.#levels.findIndex((l) => l.name === 'Section');
    this.#setZoom(section >= 0 ? section : this.#zoomIdx, this.#tileXY(c0 + SEC / 2, r0 + SEC / 2));
  }

  /** Zooms out to the whole island, centred in the clear space; for when a story closes. */
  showIsland(): void {
    if (this.#ready && this.#sections.length) this.#setZoom(0);
  }

  // -- build mode (decision 39) --

  /** How I arranged each project's section, as the hub keeps it. Safe to call before the scene starts. */
  setLayouts(layouts: Record<string, SectionLayout>): void {
    if (sameLayouts(layouts, this.#layouts)) return; // the hub passing my own change back
    this.#layouts = structuredClone(layouts);
    if (this.#ready && this.#sections.length) this.#rearrange();
  }

  /** Turns build mode on or off: while on, clicks arrange the island instead of opening stories. */
  setBuild(on: boolean): void {
    this.#build.on = on;
    this.#pick(null);
    this.#cursor?.setVisible(false);
    this.#ghost?.setVisible(false);
    if (on) this.#hint(this.#toolHint());
  }

  setTool(tool: Tool): void {
    this.#build.tool = tool;
    this.#pick(null);
    this.#ghost?.setVisible(false);
    this.#hint(this.#toolHint());
  }

  /** Takes back my last change; false when there's nothing left to take back. */
  undo(): boolean {
    const last = this.#undo.pop();
    if (!last) return false;
    this.#setLayout(last.name, last.layout ?? {}, false);
    this.#hint('Taken back.');
    return true;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  /** A picture of what a tool places, for the palette; null until the art is drawn, or for tools that place nothing. */
  preview(tool: Tool): string | null {
    if (!this.#ready) return null;
    const key = tool === 'path' ? names.tile('path') : tool === 'grass' ? names.tile('grass0') : tool === 'flowers' ? names.tile('flowers') : tool === 'water' ? names.tile('water')
      : isItem(tool) ? this.#itemLook(tool).key : isPiece(tool) ? names.play(tool) : null;
    return key ? this.textures.getBase64(key) : null;
  }

  /** Lays the camera out again after the page's panels change size, such as the side panel folding away. */
  relayout(): void {
    if (!this.#ready || !this.#sections.length) return;
    const name = this.#levels[this.#zoomIdx]?.name;
    this.#computeZoomLevels();
    const idx = this.#levels.findIndex((l) => l.name === name);
    this.#setZoom(idx >= 0 ? idx : Math.min(this.#zoomIdx, this.#levels.length - 1));
  }

  zoomBy(step: number): void {
    if (this.#ready) this.#setZoom(this.#zoomIdx + step);
  }

  /** Moves the camera to the next mirling that needs me, and returns its session. */
  focusNextNeeds(): string | null {
    const list = [...this.#mirlings.values()].filter((c) => c.status === 'needs-me' && !c.removed);
    if (!list.length) return null;
    this.#needsIdx = (this.#needsIdx + 1) % list.length;
    const col = list[this.#needsIdx] as Mirling;
    const section = this.#levels.findIndex((l) => l.name === 'Section');
    this.#setZoom(Math.max(this.#zoomIdx, section), { x: col.pos.x, y: col.pos.y });
    return col.id;
  }

  // -- Phaser's side --

  preload(): void {
    this.#art.preload?.(this);
  }

  create(): void {
    const before = new Set(this.textures.getTextureKeys());
    this.#art.create(this);
    for (const key of this.textures.getTextureKeys()) if (!before.has(key)) this.#artKeys.add(key);
    this.#drawBackdrop();
    this.#selectMark = this.add.image(0, 0, names.select).setVisible(false);
    this.#cursor = this.add.image(0, 0, names.cursor(true)).setVisible(false);
    this.#ghost = this.add.image(0, 0, names.cursor(true)).setVisible(false).setAlpha(0.6);
    this.#hoverLabel = this.#label('', { fontFamily: '"IBM Plex Sans", sans-serif', fontSize: '12px', color: '#ece8d9', backgroundColor: '#0b0d1add', padding: { x: 6, y: 3 } }).setVisible(false).setDepth(600002); // above the section labels
    this.#setupInput();
    this.scale.on('resize', this.#onResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.#onResize, this));
    this.#ready = true;
    if (this.#pending) this.#apply();
  }

  update(time: number, delta: number): void {
    const zoom = this.cameras.main.zoom;
    const d = DPR();
    const follow = Math.min(1, delta * 0.004);
    const ui = d / zoom; // keeps labels and marks a constant size on screen
    const { creature, beacon, bubble, thought } = this.#art.sizes;
    const beaconScale = Math.max(1, (18 * d) / (beacon * zoom));
    const bubbleScale = Math.max(1, (12 * d) / (bubble * zoom));
    const thoughtScale = Math.max(1, (12 * d) / (thought * zoom));
    const A = this.#art.scale;
    this.#drawSwings(time);
    const fall = Math.floor(time / 110) % WATERFALL_FRAMES;
    for (const f of this.#falls) {
      const key = names.waterfall(f.edge, reduceMotion ? 0 : fall);
      if (f.img.texture.key !== key) f.img.setTexture(key);
    }
    // A mirling under the pointer names itself first, then a building, then the mirling whose story is open.
    const selected = this.#selected ? this.#mirlings.get(this.#selected) : undefined;
    const pointed = this.#mirlings.get(this.#hovered ?? '');
    const building = pointed ? null : this.#hoveredBuilding;
    const labelled = pointed ?? (building ? undefined : selected);
    // Over a mirling's head: its name tag, or the label with its name and task while that shows; higher for a beacon.
    const overHead = (col: Mirling) => Math.round(col.pos.y) - creature - (col.marks.beacon ? 22 * d / zoom + 4 * A : 4 * A);
    for (const col of this.#mirlings.values()) {
      const beat = Math.floor(time / 170 + col.phase * 2) % 2;
      const key = names.creature(col.palette, col.moving && beat ? 'b' : 'a');
      if (col.sprite.texture.key !== key) col.sprite.setTexture(key);
      const x = Math.round(col.pos.x);
      let y = Math.round(col.pos.y) - (col.moving && beat && !reduceMotion ? A : 0);
      const ring = col.play?.kind === 'float' && col.aloft ? col.play : null;
      if (ring) {
        // Sat in a rubber ring, bobbing: the front half of the ring hides its feet.
        const bob = reduceMotion ? 0 : Math.round(Math.sin(time / 650 + col.phase * 6) * 1.5);
        ring.back.setVisible(true).setPosition(x, y + bob).setDepth(col.pos.y - 0.1);
        ring.front.setVisible(true).setPosition(x, y + bob).setDepth(col.pos.y + 0.1);
        y += bob + 5;
      }
      col.sprite.setFlipX(col.facing < 0).setPosition(x, y).setDepth(col.depth ?? col.pos.y);
      col.tag.setVisible(Boolean(col.name) && col !== labelled).setScale(ui).setPosition(x, overHead(col));
      const head = y - creature;
      this.#placeGear(col, x, y, head, time, thoughtScale);
      const b = col.marks.beacon;
      if (b) {
        const lift = reduceMotion ? 0 : Math.round(Math.sin(time / 220 + col.phase * 6) * 1.5) * A;
        b.img.setPosition(x, head - 2 * A + lift).setScale(beaconScale);
        b.ring.setPosition(x, head - 2 * A - b.img.displayHeight * 0.55 + lift).setScale(beaconScale * (1 + 2 * b.pulse.t)).setAlpha(1 - b.pulse.t);
      }
      col.marks.bubble?.setPosition(x + 6 * A, head).setScale(bubbleScale);
      for (const h of col.helpers.values()) {
        const tx = col.pos.x + h.off.x;
        const ty = col.pos.y + h.off.y;
        const moving = Math.abs(tx - h.pos.x) + Math.abs(ty - h.pos.y) > 1.5 * A;
        h.pos.x += (tx - h.pos.x) * follow;
        h.pos.y += (ty - h.pos.y) * follow;
        const hk = names.helper(col.palette, moving && Math.floor(time / 150 + h.phase * 2) % 2 ? 'b' : 'a');
        if (h.sprite.texture.key !== hk) h.sprite.setTexture(hk);
        h.sprite.setPosition(Math.round(h.pos.x), Math.round(h.pos.y)).setDepth(h.pos.y);
      }
    }
    if (selected) this.#selectMark.setPosition(Math.round(selected.pos.x), Math.round(selected.pos.y)).setDepth(selected.pos.y - 0.5);
    this.#hoverLabel.setVisible(Boolean(labelled || building));
    if (labelled) {
      this.#hoverLabel.setText(labelled.name ? `${labelled.name} · ${labelled.title}` : labelled.title).setScale(ui).setPosition(Math.round(labelled.pos.x), overHead(labelled));
    } else if (building) {
      this.#hoverLabel.setText(this.#buildingSays(building)).setScale(ui).setPosition(building.x, building.top - 2 * A);
    }
    for (const sec of this.#sections) {
      sec.summary.setScale(ui).setPosition(sec.anchor.x, sec.anchor.y);
      sec.label.setScale(ui).setPosition(sec.anchor.x, sec.anchor.y - sec.summary.displayHeight);
    }
  }

  // A book with turning pages, a hammer swinging, a console flickering, or a thought bubble's dots.
  #placeGear(col: Mirling, x: number, y: number, head: number, time: number, thoughtScale: number): void {
    const A = this.#art.scale;
    const { prop, thought, swing } = col.gear;
    const f = col.facing;
    const depth = (col.depth ?? col.pos.y) + 0.2;
    const beat = (ms: number) => (reduceMotion ? 0 : Math.floor(time / ms + col.phase * 4) % 2);
    if (prop && col.act === 'read') prop.setTexture(names.prop(beat(700) ? 'book.b' : 'book.a')).setPosition(x + f * 7, y - 2).setDepth(depth);
    if (prop && col.act === 'run') prop.setTexture(names.prop(beat(300) ? 'console.b' : 'console.a')).setPosition(x + f * 11, y + 1).setDepth(depth);
    if (prop && col.act === 'make') prop.setPosition(x + f * 8, y - 5).setFlipX(f < 0).setAngle(f * (-65 + 85 * (swing?.t ?? 0))).setDepth(depth);
    thought?.setTexture(names.thought(reduceMotion ? 2 : Math.floor(time / 450) % 3)).setPosition(x + 6 * A, head).setScale(thoughtScale);
  }

  // Swing seats hang from their frames on ropes, still, or swinging with a mirling sat on them.
  #drawSwings(time: number): void {
    const { pivots, rope } = this.#art.playground.swings;
    const across = { x: 0.894, y: 0.447 }; // one step along a column, on screen: the way the seats swing
    const side = { x: -0.894 * 4, y: 0.447 * 4 }; // half a seat, along the frame
    for (const sw of this.#sections.flatMap((sec) => sec.play.swings)) {
      sw.ropes.clear();
      pivots.forEach((pivot, i) => {
        const rider = sw.seats[i];
        const play = rider?.play?.kind === 'swing' ? rider.play : null;
        const angle = play?.seated && !reduceMotion ? play.swing.amp * 0.6 * Math.sin((time - play.from) / 520) : 0;
        const px = sw.x + pivot.x;
        const py = sw.y + pivot.y;
        const seat = { x: px + across.x * rope * Math.sin(angle), y: py + rope * Math.cos(angle) + across.y * rope * Math.sin(angle) };
        sw.ropes.lineStyle(1, 0x2a2f45, 1);
        for (const s of [-1, 1]) sw.ropes.lineBetween(px + s * side.x, py + s * side.y, seat.x + s * side.x, seat.y + s * side.y);
        sw.ropes.lineStyle(2, 0x8a5a32, 1).lineBetween(seat.x - side.x, seat.y - side.y, seat.x + side.x, seat.y + side.y);
        if (rider && play?.seated) Object.assign(rider.pos, { x: seat.x, y: seat.y + 1 });
      });
    }
  }

  // -- keeping up with the hub --

  #apply(): void {
    const data = this.#pending;
    if (!data) return;
    const listed = new Set([...data.systems, ...data.sessions.map((s) => s.system)]);
    // A project the hub no longer lists leaves: I removed it, it went quiet, or it joined a group
    // (decision 47). The sections after it close up, so the island is laid out again.
    const dropped = this.#order.filter((name) => !listed.has(name));
    if (dropped.length) {
      this.#clear();
      this.#order = this.#order.filter((name) => listed.has(name));
      if (!this.#order.length) this.#buildGround(false); // nothing left: clear the ground too
    }
    const before = this.#sections.length;
    for (const name of listed) if (!this.#order.includes(name)) this.#order.push(name);
    if (this.#order.length !== before) this.#grow(before);
    for (const sec of this.#sections) sec.label.setText((data.labels[sec.name] ?? sec.name).toUpperCase());
    this.#applyGrowth(data.growth);
    this.#syncMirlings(data.sessions);
    this.#refreshSummaries();
  }

  #clear(): void {
    this.#hoveredBuilding = null;
    for (const col of [...this.#mirlings.values()]) this.#retire(col, true);
    for (const sec of this.#sections) {
      for (const b of sec.buildings) b.img.destroy();
      for (const sw of sec.play.swings) sw.ropes.destroy();
      sec.label.destroy();
      sec.summary.destroy();
    }
    this.#sections = [];
  }

  // New projects add sections at the edge; the ground is redrawn, while existing buildings and
  // mirlings stay put. A new neighbour brings a stream along a shore, so places to stand are found again.
  #grow(from: number): void {
    const animate = from > 0;
    this.#buildGround(animate);
    for (const sec of this.#sections) {
      for (const b of sec.buildings) {
        b.spots = spotsAround(b, this.#walkable);
        b.door = b.spots[0] ?? b;
      }
    }
    for (let i = from; i < this.#order.length; i++) this.#buildSection(i, animate);
    this.#computeFit();
    this.#computeZoomLevels();
    this.#setZoom(0, undefined, from === 0);
  }

  #syncMirlings(sessions: BoardSession[]): void {
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.id);
      let col = this.#mirlings.get(s.id);
      if (col && col.sec.name !== s.system) {
        this.#retire(col, true);
        col = undefined;
      }
      if (!col) {
        if (s.status === 'ended') continue; // already gone home
        col = this.#addMirling(s);
      } else if (col.status !== (s.status ?? null)) {
        this.#setStatus(col, (s.status ?? null) as Status | null);
      }
      col.title = sessionLabel(s);
      if (col.name !== (s.name ?? '')) {
        col.name = s.name ?? '';
        col.tag.setText(col.name);
      }
      this.#syncHelpers(col, s);
    }
    for (const col of [...this.#mirlings.values()]) if (!seen.has(col.id)) this.#retire(col, false);
    this.select(this.#selected);
  }

  // -- the island --

  #walkable = (c: number, r: number) => this.#cells.get(`${c},${r}`)?.walk ?? false;

  #tileXY(c: number, r: number) {
    const { w, h } = this.#art.tile;
    return { x: (c - r) * (w / 2), y: (c + r) * (h / 2) };
  }

  #buildGround(animate: boolean): void {
    const known = new Set(this.#cells.keys());
    for (const obj of this.#ground) obj.destroy();
    this.#ground = [];
    this.#pieceImages.clear();
    this.#cells = generateCells(this.#order.map((name) => this.#templates.get(name) ?? 'code'));
    this.#placements.clear();
    this.#order.forEach((name, i) => this.#placements.set(name, arrange(this.#cells, i, this.#templates.get(name) ?? 'code', this.#layouts[name])));
    const { w, h, side } = this.#art.tile;
    const A = this.#art.scale;
    const fresh: Image[] = [];
    this.#falls = [];
    const is = (c: number, r: number, ch: string) => this.#cells.get(`${c},${r}`)?.ch === ch;
    [...this.#cells.values()].sort((a, b) => a.c + a.r - (b.c + b.r)).forEach((cell) => {
      const { x, y } = this.#tileXY(cell.c, cell.r);
      const kind = cell.ch === 'p' ? 'path' : cell.ch === 'w' ? 'water' : cell.ch === 'f' ? 'flowers' : cell.ch === 'b' ? (`deck-${cell.span ?? 'c'}` as const) : (`grass${Math.floor(hash(cell.c, cell.r, 3) * 3)}` as 'grass0');
      const sink = cell.ch === 'w' ? WATER_DROP * A : 0;
      const tile = this.add.image(x, y + sink, names.tile(kind)).setOrigin(0.5, h / 2 / (h + side)).setDepth(-100000 + cell.c + cell.r);
      this.#ground.push(tile);
      let deco: Image | null = null;
      const extra: Image[] = [];
      if (cell.ch === 'b') {
        // Rails along a bridge's sides, where no more bridge carries on: behind a mirling crossing, or in front.
        const sides: Array<[Edge, boolean]> = cell.span === 'r'
          ? [['nw', !is(cell.c - 1, cell.r, 'b')], ['se', !is(cell.c + 1, cell.r, 'b')]]
          : [['ne', !is(cell.c, cell.r - 1, 'b')], ['sw', !is(cell.c, cell.r + 1, 'b')]];
        for (const [edge, railed] of sides) {
          if (!railed) continue;
          const a = this.#art.anchor(names.rail(edge));
          extra.push(this.add.image(x, y, names.rail(edge)).setOrigin(a.ox, a.oy).setDepth(edge === 'ne' || edge === 'nw' ? y - h / 2 : y + h / 2));
        }
      } else if (cell.ch === 'w') {
        // A stream reaching the island's front edge pours off it.
        for (const [edge, open, left] of [['se', !this.#cells.has(`${cell.c + 1},${cell.r}`), x], ['sw', !this.#cells.has(`${cell.c},${cell.r + 1}`), x - w / 2]] as const) {
          if (!open) continue;
          const img = this.add.image(left, y + sink, names.waterfall(edge, 0)).setOrigin(0, 0).setDepth(tile.depth + 0.5);
          this.#falls.push({ img, edge });
          extra.push(img);
        }
      } else if (pieceAt(cell)) {
        const key = names.play(pieceAt(cell) as PieceKind);
        const a = this.#art.anchor(key);
        deco = this.add.image(x, y, key).setOrigin(a.ox, a.oy).setDepth(y);
        this.#pieceImages.set(`${cell.c},${cell.r}`, deco);
      } else if (cell.ch === 'T') {
        deco = this.add.image(x, y + 3 * A, names.tree(hash(cell.c, cell.r, 4) < 0.4)).setOrigin(0.5, 1).setDepth(y + 3 * A);
      }
      if (cell.item && isItem(cell.item)) {
        const look = this.#itemLook(cell.item);
        deco = this.add.image(x, y + look.drop, look.key).setOrigin(look.ox, look.oy).setDepth(look.flat ? tile.depth + 0.6 : y + look.drop);
      }
      if (deco) extra.push(deco);
      this.#ground.push(...extra);
      if (animate && !known.has(`${cell.c},${cell.r}`)) fresh.push(tile, ...extra);
    });
    const under = this.#underside();
    if (under) this.#ground.push(under);
    if (animate && !reduceMotion) {
      for (const obj of fresh) {
        const y = obj.y;
        obj.setAlpha(0).setY(y + 16 * A);
        this.tweens.add({ targets: obj, y, alpha: 1, duration: 450, delay: 100 + ((obj.depth + 100000) % 1000) * 14, ease: 'Back.easeOut' });
      }
    }
  }

  #underside(): Image | null {
    const { w, h, side } = this.#art.tile;
    const columns = new Map<number, number>();
    for (const cell of this.#cells.values()) {
      const { x, y } = this.#tileXY(cell.c, cell.r);
      // The lowest ground pixel of each column: the bottom tip of the tile's side.
      for (let i = 0; i < w; i++) {
        const wx = x - w / 2 + i;
        const wy = y + h / 2 - Math.abs(i + 0.5 - w / 2) / 2 + side;
        if (!columns.has(wx) || (columns.get(wx) as number) < wy) columns.set(wx, Math.round(wy));
      }
    }
    if (!columns.size) return null;
    const key = `underside.${this.#order.length}`;
    this.#art.underside(this, columns, key);
    return this.add.image(Math.min(...columns.keys()), Math.min(...columns.values()), key).setOrigin(0, 0).setDepth(-200000);
  }

  #buildSection(i: number, animate: boolean): void {
    const name = this.#order[i] as string;
    const template = this.#templates.get(name) ?? 'code';
    const accent = ACCENTS[i % ACCENTS.length] as Accent;
    const A = this.#art.scale;
    const sec: Section = { i, name, accent, template, buildings: [], houses: [], anchor: { x: 0, y: 0 }, label: null as unknown as Text, summary: null as unknown as Text, play: this.#playgroundOf(i) };
    for (const tb of this.#placements.get(name) ?? arrange(new Map(), i, template)) {
      const { x, y } = this.#tileXY(tb.c, tb.r);
      const img = this.add.image(x, y, names.select).setDepth(y);
      const spots = spotsAround(tb, this.#walkable);
      const b: Building = { ...tb, x, y, top: y, img, spots, door: spots[0] ?? tb, residents: 0, level: 1 };
      if (b.type === 'workshop' || b.type === 'library') {
        img.setInteractive({ pixelPerfect: true });
        img.on('pointerover', () => { this.#hoveredBuilding = b; });
        img.on('pointerout', () => { if (this.#hoveredBuilding === b) this.#hoveredBuilding = null; });
      }
      this.#fitBuilding(b);
      sec.buildings.push(b);
      if (b.type === 'house') sec.houses.push(b);
      if (animate && !reduceMotion) {
        img.setAlpha(0);
        this.tweens.add({ targets: img, alpha: 1, duration: 400, delay: 650 });
      }
    }
    const { c0, r0 } = sectionOrigin(i);
    const corner = this.#tileXY(c0, r0);
    sec.anchor = { x: corner.x, y: corner.y - this.#art.tile.h / 2 - 2 * A };
    sec.summary = this.#label('', { fontFamily: '"IBM Plex Mono", monospace', fontSize: '11px', color: '#c9c8dc', backgroundColor: '#0b0d1acc', padding: { x: 5, y: 2 } });
    sec.label = this.#label(name.toUpperCase(), { fontFamily: '"IBM Plex Mono", monospace', fontStyle: '600', fontSize: '13px', color: ACCENT_COLOUR[accent], backgroundColor: '#0b0d1acc', padding: { x: 5, y: 2 } });
    for (const text of [sec.label, sec.summary]) text.setInteractive({ useHandCursor: true }).setData('section', name);
    this.#sections.push(sec);
  }

  // A section's swings, slides, trampolines and pond, wherever its template and my layout put them.
  // A piece that stayed put is kept as it was, with whoever is on it.
  #playgroundOf(i: number, old?: Playground): Playground {
    const play: Playground = { swings: [], slides: [], trampolines: [], pond: [], floating: old?.floating ?? new Set() };
    const { c0, r0 } = sectionOrigin(i);
    const kept = <T extends Spot>(list: T[] | undefined, cell: Cell) => list?.find((p) => p.c === cell.c && p.r === cell.r);
    for (const cell of this.#cells.values()) {
      if ((cell.by ?? cell.section) !== i) continue;
      const { x, y } = this.#tileXY(cell.c, cell.r);
      const spot = { c: cell.c, r: cell.r };
      const piece = pieceAt(cell);
      if (piece === 'swings') play.swings.push(kept(old?.swings, cell) ?? { ...spot, x, y, seats: this.#art.playground.swings.pivots.map(() => null), ropes: this.add.graphics().setDepth(y + 0.5) });
      if (piece === 'slide') play.slides.push(kept(old?.slides, cell) ?? { ...spot, x, y, users: new Set() });
      if (piece === 'trampoline') play.trampolines.push(kept(old?.trampolines, cell) ?? { ...spot, x, y, users: new Set() });
      const inside = [cell.c - c0, cell.r - r0].every((v) => v > 0 && v < SEC - 1);
      if (cell.ch === 'w' && inside) play.pond.push(spot);
    }
    return play;
  }

  #fitBuilding(b: Building): void {
    const key = b.type === 'house' ? names.house(b.style, b.residents > 0) : names.building(b.type, b.level);
    const a = this.#art.anchor(key);
    b.img.setTexture(key).setOrigin(a.ox, a.oy);
    b.top = b.y - a.height;
  }

  #label(text: string, style: Phaser.Types.GameObjects.Text.TextStyle): Text {
    const t = this.add.text(0, 0, text, { resolution: DPR(), ...style }).setOrigin(0.5, 1).setDepth(600000);
    t.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    return t;
  }

  #refreshSummaries(): void {
    for (const sec of this.#sections) {
      const here = [...this.#mirlings.values()].filter((c) => c.sec === sec && !c.removed);
      const needs = here.filter((c) => c.status === 'needs-me').length;
      sec.summary.setText(here.length ? `${here.length} session${here.length === 1 ? '' : 's'}${needs ? ` · ${needs} need${needs === 1 ? 's' : ''} you` : ''}` : 'quiet');
      sec.summary.setColor(needs ? '#ff8a3d' : '#c9c8dc');
    }
  }

  #workFor(sec: Section, tool?: string): Building {
    const wanted: BuildingType = tool && READING.has(tool) ? 'library' : 'workshop';
    return sec.buildings.find((b) => b.type === wanted) ?? (sec.buildings.find((b) => b.type !== 'house') as Building) ?? (sec.houses[0] as Building);
  }

  // -- mirlings --

  #spotXY(cell: Spot) {
    const { x, y } = this.#tileXY(cell.c, cell.r);
    const A = this.#art.scale;
    return { x: x + rand(-5, 5) * A, y: y + rand(-1, 3) * A };
  }

  #addMirling(s: BoardSession): Mirling {
    const sec = this.#sections.find((x) => x.name === s.system) as Section;
    const home = [...sec.houses].sort((a, b) => a.residents - b.residents)[0] as Building;
    const work = this.#workFor(sec, s.lastTool);
    const cell = s.status === 'working' ? pickOne(this.#workSpots(work)) : home.door;
    const pos = this.#spotXY(cell);
    const palette: Palette = 'y';
    const sprite = this.add.image(pos.x, pos.y, names.creature(palette, 'a')).setOrigin(0.5, 1);
    const w = sprite.width;
    const h = sprite.height;
    sprite.setInteractive({ hitArea: new Phaser.Geom.Rectangle(-w * 0.6, -h * 0.7, w * 2.2, h * 1.9), hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true });
    sprite.setData('session', s.id);
    sprite.on('pointerover', () => { this.#hovered = s.id; });
    sprite.on('pointerout', () => { if (this.#hovered === s.id) this.#hovered = null; });
    // Its name over its head, drawn above the island but below the section names and the pointed-at label.
    const tag = this.#label(s.name ?? '', { fontFamily: '"IBM Plex Sans", sans-serif', fontSize: '10px', color: '#ece8d9', backgroundColor: '#0b0d1aaa', padding: { x: 4, y: 1 } })
      .setDepth(599999).setVisible(Boolean(s.name));
    const col: Mirling = {
      id: s.id, title: sessionLabel(s), name: s.name ?? '', tag, sec, home, work, cell, pos, sprite, status: null, base: palette, palette,
      walkId: 0, moving: false, facing: 1, phase: Math.random(), marks: {}, helpers: new Map(), removed: false,
      tool: null, act: null, gear: {}, play: null, aloft: false, later: [],
    };
    home.residents += 1;
    this.#fitBuilding(home);
    this.#mirlings.set(s.id, col);
    if (!reduceMotion) {
      sprite.setAlpha(0);
      tag.setAlpha(0);
      this.tweens.add({ targets: [sprite, tag], alpha: 1, duration: 500 });
    }
    this.#setStatus(col, (s.status ?? null) as Status | null);
    return col;
  }

  /** Walks to a tile, hopping down first if it's up on the playground; `slow` stretches each step. */
  #walkTo(col: Mirling, target: Spot, done?: () => void, slow = 1): void {
    const id = ++col.walkId;
    const A = this.#art.scale;
    const walk = () => {
      const path = findPath(this.#walkable, col.cell, target);
      const step = () => {
        if (col.walkId !== id || col.removed) return;
        const next = path.shift();
        if (!next) {
          col.moving = false;
          done?.();
          return;
        }
        const to = this.#spotXY(next);
        const dist = Math.hypot(to.x - col.pos.x, to.y - col.pos.y);
        col.moving = true;
        if (Math.abs(to.x - col.pos.x) > A) col.facing = to.x < col.pos.x ? -1 : 1;
        this.tweens.add({ targets: col.pos, x: to.x, y: to.y, duration: Math.max(140, (dist / A) * 26) * slow, onComplete: () => { col.cell = next; step(); } });
      };
      step();
    };
    if (!col.aloft) return walk();
    this.#hop(col, this.#spotXY(col.cell), () => {
      col.aloft = false;
      col.depth = undefined;
      if (col.walkId === id) walk();
    });
  }

  /** A little jump from where it is to a point, for getting on and off the playground. */
  #hop(col: Mirling, to: { x: number; y: number }, done: () => void): void {
    const from = { x: col.pos.x, y: col.pos.y };
    const lift = 7 * this.#art.scale;
    const t = { k: 0 };
    col.moving = false;
    if (Math.abs(to.x - from.x) > 1) col.facing = to.x < from.x ? -1 : 1;
    this.#track(col, this.tweens.add({
      targets: t, k: 1, duration: reduceMotion ? 1 : 340,
      onUpdate: () => Object.assign(col.pos, { x: from.x + (to.x - from.x) * t.k, y: from.y + (to.y - from.y) * t.k - Math.sin(Math.PI * t.k) * lift }),
      onComplete: done,
    }));
  }

  /** Keeps a tween or timer with what the mirling is doing now, so a change of plan stops it. */
  #track<T extends { remove(): unknown }>(col: Mirling, thing: T): T {
    col.later.push(thing);
    return thing;
  }

  #setStatus(col: Mirling, status: Status | null): void {
    col.status = status;
    col.walkId += 1;
    this.tweens.killTweensOf(col.pos);
    col.moving = false;
    this.#stopActing(col);
    this.#clearMarks(col);
    col.palette = status === 'failed' ? 'g' : col.base;
    if (status === 'working') {
      this.#work(col);
    } else if (status === 'needs-me' || status === 'failed') {
      // It stops where it is, on the ground, and calls for me.
      if (status === 'needs-me') this.#addBeacon(col);
      else this.#addSmoke(col);
      if (col.aloft) this.#walkTo(col, col.cell);
    } else if (status === 'ended') {
      this.#walkTo(col, col.home.door, () => this.#retire(col, false));
    } else if (status === 'my-turn') {
      // My turn: it goes to play until I reply, with a speech bubble so I know it's waiting (decision 41).
      this.#addBubble(col);
      this.#chill(col);
    } else {
      this.#walkTo(col, col.home.door);
    }
    this.#refreshSummaries();
  }

  // -- working (decision 41) --

  /** Goes to do what its tool calls for, or thinks on its feet when no tool is running. */
  #work(col: Mirling): void {
    const act = actFor(col.tool);
    const work = act === 'think' ? col.work : this.#workFor(col.sec, col.tool ?? undefined);
    if (col.act === act && col.work === work && !col.aloft) return; // already at it
    this.#stopActing(col);
    col.act = act;
    col.work = work;
    if (act === 'think') {
      col.gear.thought = this.add.image(col.pos.x, col.pos.y, names.thought(0)).setOrigin(0.5, 1).setDepth(500000);
      return this.#ponder(col);
    }
    this.#walkTo(col, pickOne(this.#workSpots(work)), () => this.#atWork(col));
  }

  // Where a mirling stands to work at a building: beside or in front of it, where it can be seen, if there's room.
  #workSpots(b: Building): Spot[] {
    const seen = b.spots.filter((s) => s.c + s.r >= b.c + b.r);
    return seen.length ? seen : b.spots.length ? b.spots : [b.door];
  }

  // At the building, facing it, with its book, hammer or console; now and then it moves along.
  #atWork(col: Mirling): void {
    const act = col.act;
    if (!act || act === 'think') return;
    col.facing = col.work.x < col.pos.x ? -1 : 1;
    const key = act === 'read' ? names.prop('book.a') : act === 'make' ? names.prop('hammer') : names.prop('console.a');
    col.gear.prop = this.add.image(col.pos.x, col.pos.y, key).setOrigin(0.5, 1);
    if (act === 'make') {
      const swing = { t: 0 };
      col.gear.swing = swing;
      if (!reduceMotion) this.#track(col, this.tweens.add({ targets: swing, t: 1, duration: 240, yoyo: true, repeat: -1, repeatDelay: 160, ease: 'Quad.easeIn', onYoyo: () => this.#spark(col) }));
    }
    const id = col.walkId;
    this.#track(col, this.time.delayedCall(rand(5000, 9000), () => {
      if (col.walkId !== id || col.act !== act || col.removed || this.#workSpots(col.work).length < 2) return;
      this.#putDown(col);
      this.#walkTo(col, pickOne(this.#workSpots(col.work)), () => this.#atWork(col));
    }));
  }

  // The hammer strikes: a spark where its head lands.
  #spark(col: Mirling): void {
    if (reduceMotion || !col.gear.prop) return;
    const spark = this.add.image(col.pos.x + col.facing * 14, col.pos.y - 3, names.prop('spark')).setDepth(col.pos.y + 0.3);
    this.tweens.add({ targets: spark, y: spark.y - 5, alpha: 0, duration: 260, onComplete: () => spark.destroy() });
  }

  #putDown(col: Mirling): void {
    if (col.gear.swing) this.tweens.killTweensOf(col.gear.swing);
    col.gear.prop?.destroy();
    col.gear = { thought: col.gear.thought };
  }

  // Thinking: a slow walk to somewhere nearby in its section, a pause, and on again.
  #ponder(col: Mirling): void {
    const here = col.cell;
    const near = [...this.#cells.values()].filter((cell) => cell.section === col.sec.i && cell.walk && Math.max(Math.abs(cell.c - here.c), Math.abs(cell.r - here.r)) >= 2 && Math.max(Math.abs(cell.c - here.c), Math.abs(cell.r - here.r)) <= 4);
    const paths = near.filter((cell) => cell.ch === 'p');
    const to = paths.length && Math.random() < 0.7 ? pickOne(paths) : near.length ? pickOne(near) : here;
    this.#walkTo(col, to, () => {
      const id = col.walkId;
      this.#track(col, this.time.delayedCall(rand(1500, 3500), () => {
        if (col.walkId === id && col.act === 'think' && col.status === 'working' && !col.removed) this.#ponder(col);
      }));
    }, 1.7);
  }

  /** Stops working or playing: puts its things away and gives up its place on the playground; it hops down when it next walks. */
  #stopActing(col: Mirling): void {
    for (const thing of col.later) thing.remove();
    col.later = [];
    this.#putDown(col);
    col.gear.thought?.destroy();
    col.gear = {};
    col.act = null;
    const play = col.play;
    const pg = col.sec.play;
    if (play?.kind === 'swing') play.frame.seats[play.seat] = null;
    if (play?.kind === 'slide' || play?.kind === 'bounce') play.ride.users.delete(col);
    if (play?.kind === 'float') {
      play.back.destroy();
      play.front.destroy();
      pg.floating.delete(col);
    }
    col.play = null;
  }

  // -- waiting for me (decision 41) --

  /** Picks something to play at: a free swing, a slide, a trampoline or the pond, and now and then something else. */
  #chill(col: Mirling): void {
    const pg = col.sec.play;
    const choices: Array<() => void> = [];
    for (const sw of pg.swings) {
      const seat = sw.seats.indexOf(null);
      if (seat >= 0) choices.push(() => this.#swing(col, sw, seat), () => this.#swing(col, sw, seat));
    }
    for (const sl of pg.slides) if (sl.users.size < SLIDERS) choices.push(() => this.#slide(col, sl));
    for (const tr of pg.trampolines) if (tr.users.size < JUMPERS) choices.push(() => this.#bounce(col, tr), () => this.#bounce(col, tr));
    if (this.#openWater(pg).length && pg.floating.size < POND_FLOATERS) choices.push(() => this.#float(col), () => this.#float(col));
    if (!choices.length) return this.#walkTo(col, col.home.door); // nowhere free: it waits at home
    pickOne(choices)();
    this.#track(col, this.time.delayedCall(rand(30000, 60000), () => {
      if (col.status !== 'my-turn' || col.removed) return;
      this.#stopActing(col);
      this.#chill(col);
    }));
  }

  // The tiles beside a playground piece, nearest a point first.
  #beside(spot: Spot, near?: { x: number; y: number }): Spot[] {
    const spots = spotsAround(spot, this.#walkable);
    if (!near) return spots;
    const d = (s: Spot) => { const p = this.#tileXY(s.c, s.r); return Math.hypot(p.x - near.x, p.y - near.y); };
    return spots.sort((a, b) => d(a) - d(b));
  }

  #swing(col: Mirling, sw: SwingSet, seat: number): void {
    const pivot = this.#art.playground.swings.pivots[seat];
    const from = pivot ? this.#beside(sw, { x: sw.x + pivot.x, y: sw.y })[0] : undefined;
    if (!pivot || !from) return this.#walkTo(col, col.home.door);
    const play: Play = { kind: 'swing', frame: sw, seat, seated: false, from: 0, swing: { amp: 0 } };
    sw.seats[seat] = col;
    col.play = play;
    this.#walkTo(col, from, () => {
      this.#hop(col, { x: sw.x + pivot.x, y: sw.y + pivot.y + this.#art.playground.swings.rope + 1 }, () => {
        Object.assign(col, { aloft: true, depth: sw.y + 1 });
        Object.assign(play, { seated: true, from: this.time.now });
        this.#track(col, this.tweens.add({ targets: play.swing, amp: 1, duration: 1800, ease: 'Sine.easeOut' }));
      });
    });
  }

  // Up the ladder, a moment at the top, down the chute, off at the front, and round again.
  #slide(col: Mirling, sl: Ride): void {
    const { ladder, top, foot } = this.#art.playground.slide;
    const at = (p: { x: number; y: number }) => ({ x: sl.x + p.x, y: sl.y + p.y });
    const back = this.#beside(sl, at(ladder))[0];
    const front = this.#beside(sl, at(foot))[0];
    if (!back || !front) return this.#walkTo(col, col.home.door);
    const play: Play = { kind: 'slide', ride: sl };
    sl.users.add(col);
    col.play = play;
    const still = () => col.play === play && !col.removed;
    const round = () => this.#walkTo(col, back, () => this.#hop(col, at(ladder), () => {
      if (!still()) return;
      Object.assign(col, { aloft: true, depth: sl.y + 2, moving: true });
      this.#track(col, this.tweens.add({ targets: col.pos, ...at(top), duration: 1100, onComplete: () => {
        col.moving = false;
        this.#track(col, this.tweens.add({ targets: col.pos, ...at(foot), delay: 450, duration: 520, ease: 'Quad.easeIn', onComplete: () => {
          this.#hop(col, this.#spotXY(front), () => {
            Object.assign(col, { aloft: false, depth: undefined, cell: front });
            this.#track(col, this.time.delayedCall(rand(800, 2200), () => { if (still()) round(); }));
          });
        } }));
      } }));
    }));
    round();
  }

  // Up onto a free spot on the trampoline's mat, then bouncing on it until I reply.
  #bounce(col: Mirling, tr: Ride): void {
    const { spots } = this.#art.playground.trampoline;
    const taken = new Set([...tr.users].map((m) => (m.play?.kind === 'bounce' ? m.play.spot : -1)));
    const spot = spots.findIndex((_, k) => !taken.has(k));
    const mat = spots[spot];
    const on = mat && { x: tr.x + mat.x, y: tr.y + mat.y };
    const from = on ? this.#beside(tr, on)[0] : undefined;
    if (!on || !from) return this.#walkTo(col, col.home.door);
    const play: Play = { kind: 'bounce', ride: tr, spot };
    tr.users.add(col);
    col.play = play;
    const A = this.#art.scale;
    this.#walkTo(col, from, () => this.#hop(col, on, () => {
      if (col.play !== play || col.removed) return;
      Object.assign(col, { aloft: true, depth: tr.y + 2 });
      if (reduceMotion) return;
      this.#track(col, this.tweens.add({ targets: col.pos, y: on.y - 10 * A, duration: 340, ease: 'Quad.easeOut', yoyo: true, repeat: -1, repeatDelay: 80, delay: rand(0, 400) }));
    }));
  }

  // Into the pond on a rubber ring, drifting from tile to tile.
  #float(col: Mirling): void {
    const pg = col.sec.play;
    const open = this.#openWater(pg);
    const into = open.length ? pickOne(open) : undefined;
    const shore = into && this.#beside(into, this.#tileXY(into.c, into.r))[0];
    if (!into || !shore) return this.#walkTo(col, col.home.door);
    const play: Play = { kind: 'float', back: this.add.image(0, 0, names.ring('back')).setVisible(false), front: this.add.image(0, 0, names.ring('front')).setVisible(false) };
    pg.floating.add(col);
    col.play = play;
    const still = () => col.play === play && !col.removed;
    const drift = () => {
      if (!still()) return;
      const water = this.#openWater(pg);
      const to = this.#onWater(water.length ? pickOne(water) : into);
      if (Math.abs(to.x - col.pos.x) > 2) col.facing = to.x < col.pos.x ? -1 : 1;
      this.#track(col, this.tweens.add({ targets: col.pos, ...to, duration: rand(3500, 6000), ease: 'Sine.easeInOut', delay: rand(800, 2500), onComplete: drift }));
    };
    this.#walkTo(col, shore, () => this.#hop(col, this.#onWater(into), () => {
      col.aloft = true;
      drift();
    }));
  }

  // The pond's tiles with nothing placed on them, where a ring can drift.
  #openWater(pg: Playground): Spot[] {
    return pg.pond.filter((s) => !this.#cells.get(`${s.c},${s.r}`)?.item);
  }

  // A point on a water tile, near enough its middle that a ring stays on the water.
  #onWater(spot: Spot): { x: number; y: number } {
    const { x, y } = this.#tileXY(spot.c, spot.r);
    const A = this.#art.scale;
    return { x: x + rand(-6, 6) * A, y: y + (WATER_DROP + rand(-2, 2)) * A };
  }

  // Goes inside and turns the light off; `now` skips the fade, for a session that moved to another project.
  #retire(col: Mirling, now: boolean): void {
    if (col.removed) return;
    col.removed = true;
    col.walkId += 1;
    this.#stopActing(col);
    col.pause?.remove();
    this.#clearMarks(col);
    for (const h of col.helpers.values()) h.sprite.destroy();
    col.helpers.clear();
    this.tweens.killTweensOf(col.pos);
    if (now || reduceMotion) {
      col.sprite.destroy();
      col.tag.destroy();
    } else {
      this.tweens.add({ targets: [col.sprite, col.tag], alpha: 0, duration: 500, onComplete: () => { col.sprite.destroy(); col.tag.destroy(); } });
    }
    col.home.residents = Math.max(0, col.home.residents - 1);
    this.#fitBuilding(col.home);
    this.#mirlings.delete(col.id);
    if (this.#hovered === col.id) this.#hovered = null;
    this.#refreshSummaries();
  }

  #syncHelpers(col: Mirling, s: BoardSession): void {
    const working = new Set(s.subagents.filter((a) => a.status === 'working').map((a) => a.id));
    const A = this.#art.scale;
    for (const [id, h] of col.helpers) {
      if (working.has(id)) continue;
      col.helpers.delete(id);
      this.tweens.add({ targets: h.sprite, alpha: 0, duration: 400, onComplete: () => h.sprite.destroy() });
    }
    for (const id of working) {
      if (col.helpers.has(id)) continue;
      col.helpers.set(id, {
        pos: { x: col.pos.x, y: col.pos.y },
        off: { x: rand(-13, 13) * A, y: rand(2, 7) * A },
        phase: Math.random(),
        sprite: this.add.image(col.pos.x, col.pos.y, names.helper(col.palette, 'a')).setOrigin(0.5, 1),
      });
    }
  }

  #addBeacon(col: Mirling): void {
    const A = this.#art.scale;
    const img = this.add.image(col.pos.x, col.pos.y, names.beacon).setOrigin(0.5, 1).setDepth(500002);
    const ring = this.add.circle(col.pos.x, col.pos.y, 5 * A).setStrokeStyle(A, 0xff8a3d).setDepth(500001);
    const pulse = { t: 0 };
    if (!reduceMotion) this.tweens.add({ targets: pulse, t: 1, duration: 1100, repeat: -1 });
    col.marks.beacon = { img, ring, pulse };
  }

  #addBubble(col: Mirling): void {
    col.marks.bubble = this.add.image(col.pos.x, col.pos.y, names.bubble).setOrigin(0.5, 1).setDepth(500000);
  }

  #addSmoke(col: Mirling): void {
    const A = this.#art.scale;
    col.marks.smoke = this.time.addEvent({
      delay: reduceMotion ? 1500 : 650,
      loop: true,
      callback: () => {
        const puff = this.add.image(col.pos.x + rand(-3, 3) * A, col.pos.y - 9 * A, names.smoke).setDepth(col.pos.y + 1);
        this.tweens.add({ targets: puff, y: puff.y - 16 * A, alpha: 0, scale: 1.5, duration: 1500, onComplete: () => puff.destroy() });
      },
    });
  }

  #clearMarks(col: Mirling): void {
    const m = col.marks;
    if (m.beacon) {
      this.tweens.killTweensOf(m.beacon.pulse);
      m.beacon.img.destroy();
      m.beacon.ring.destroy();
    }
    m.bubble?.destroy();
    m.smoke?.remove();
    col.marks = {};
  }

  // The tool a mirling just picked up, rising from its head.
  #floatText(col: Mirling, text: string): void {
    this.#floatAt(col.pos.x, col.pos.y - this.#art.sizes.creature - 2 * this.#art.scale, text);
  }

  #floatAt(x: number, y: number, text: string, color = '#ffd34d'): void {
    if (reduceMotion) return;
    const A = this.#art.scale;
    const label = this.add.text(x, y, text, { fontFamily: '"IBM Plex Mono", monospace', fontSize: '12px', color, resolution: DPR() })
      .setOrigin(0.5, 1).setDepth(600001).setScale(DPR() / this.cameras.main.zoom);
    label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.tweens.add({ targets: label, y: label.y - 14 * A, alpha: 0, duration: 1600, onComplete: () => label.destroy() });
  }

  // Workshops and libraries take their level from the project's commits. A rise after the first
  // counts shows as the building springing up, and new commits float up from it.
  #applyGrowth(growth: Record<string, SectionGrowth>): void {
    for (const sec of this.#sections) {
      const next = growth[sec.name];
      if (!next) continue;
      const last = sec.growth;
      sec.growth = next;
      for (const b of sec.buildings) {
        if (b.type !== 'workshop' && b.type !== 'library') continue;
        const level = Math.min(MAX_LEVEL, b.type === 'workshop' ? next.workshop : next.library);
        const gained = b.type === 'workshop' ? next.commits - (last?.commits ?? next.commits) : next.docs - (last?.docs ?? next.docs);
        if (level !== b.level) {
          const grew = Boolean(last) && level > b.level;
          b.level = level;
          this.#fitBuilding(b);
          if (grew && !reduceMotion) this.tweens.add({ targets: b.img, scaleY: { from: 1.15, to: 1 }, duration: 360, ease: 'Back.easeOut' });
        }
        if (gained > 0) this.#floatAt(b.x, b.top - 4 * this.#art.scale, `+${gained} ${b.type === 'workshop' ? 'commit' : 'doc change'}${gained === 1 ? '' : 's'}`);
      }
    }
  }

  #buildingSays(b: Building): string {
    const g = this.#sections.find((sec) => sec.buildings.includes(b))?.growth;
    const days = 30;
    return b.type === 'workshop'
      ? `Workshop · ${g?.commits ?? 0} commit${g?.commits === 1 ? '' : 's'} in ${days} days`
      : `Library · ${g?.docs ?? 0} doc change${g?.docs === 1 ? '' : 's'} in ${days} days`;
  }

  #drawBackdrop(): void {
    const A = this.#art.scale;
    let seed = 99;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const stars = [0xffffff, 0xcfd6ff, 0xffe9b0, 0x7d82b8];
    // Soft nebulae: small radial gradients scaled up, so they band like pixel art.
    for (const [key, rgb, x, y, s] of [['haze_violet', '91,63,168', -500, 200, 14], ['haze_teal', '31,111,139', 600, 150, 12], ['haze_rose', '139,63,111', 0, 800, 14]] as Array<[string, string, number, number, number]>) {
      if (!this.textures.exists(key)) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, `rgba(${rgb},0.28)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        this.textures.addCanvas(key, canvas);
      }
      this.add.image(x * A, y * A, key).setScale(s * A).setScrollFactor(0.15).setDepth(-1000001);
    }
    const field = this.add.graphics().setScrollFactor(0.3).setDepth(-1000000);
    for (let i = 0; i < 1600; i++) {
      field.fillStyle(stars[Math.floor(rnd() * stars.length)] as number, 0.35 + rnd() * 0.65);
      field.fillRect(Math.floor((-2600 + rnd() * 5600) * A), Math.floor((-1600 + rnd() * 4000) * A), A, A);
    }
    if (!reduceMotion) {
      for (let i = 0; i < 24; i++) {
        const star = this.add.rectangle(Math.floor((-900 + rnd() * 2000) * A), Math.floor((-400 + rnd() * 1400) * A), A, A, 0xffffff).setScrollFactor(0.3).setDepth(-999999);
        this.tweens.add({ targets: star, alpha: 0.15, duration: 900 + rnd() * 1800, yoyo: true, repeat: -1, delay: rnd() * 2000 });
      }
    }
  }

  // -- camera and input --

  #computeFit(): void {
    const { w, h, side } = this.#art.tile;
    const A = this.#art.scale;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const cell of this.#cells.values()) {
      const { x, y } = this.#tileXY(cell.c, cell.r);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return;
    const top = minY - h / 2 - 30 * A;
    const bottom = maxY + h / 2 + side + 24 * A;
    this.#fit = { x: minX - w / 2, y: top, w: maxX - minX + w, h: bottom - top };
  }

  #insets() {
    const d = DPR();
    const { top, bottom, left } = this.#options.insets();
    return { top: top * d, bottom: Math.min(bottom, window.innerHeight * 0.35) * d, left: left * d };
  }

  /** Where the camera centres so a world point shows in the middle of the clear space. */
  #centerFor(point: { x: number; y: number }, zoom: number) {
    const d = DPR();
    const { top, bottom, left, right } = this.#options.insets();
    const below = Math.min(bottom, window.innerHeight * 0.35);
    return { x: point.x - (((left - right) / 2) * d) / zoom, y: point.y - (((top - below) / 2) * d) / zoom };
  }

  #computeZoomLevels(): void {
    const d = DPR();
    const inset = this.#insets();
    const { w, h } = this.#art.tile;
    const availW = Math.max(120 * d, this.scale.width - inset.left - 32 * d);
    const availH = Math.max(120 * d, this.scale.height - inset.top - inset.bottom);
    const snap = (z: number) => (z >= 1 ? Math.floor(z) : z);
    // Everything always fits the screen; closer levels snap to whole steps so pixels stay even.
    const all = Math.min(availW / this.#fit.w, availH / this.#fit.h);
    const section = Math.max(all, snap(Math.min(availW / (SEC * w * 1.15), availH / (SEC * h * 1.5))));
    const close = section >= 1 ? Math.floor(section) + 1 : 1;
    const levels: Array<{ name: string; zoom: number }> = [];
    for (const level of [{ name: 'Everything', zoom: all }, { name: 'Section', zoom: section }, { name: 'Close-up', zoom: close }]) {
      const last = levels[levels.length - 1];
      if (!last || level.zoom - last.zoom > 0.01) levels.push(level);
    }
    this.#levels = levels;
  }

  #everythingCenter(zoom: number) {
    return this.#centerFor({ x: this.#fit.x + this.#fit.w / 2, y: this.#fit.y + this.#fit.h / 2 }, zoom);
  }

  #applyFilter(zoom: number): void {
    // Hard pixels when enlarging; smoothing only when shrinking art below its drawn size.
    const mode = zoom >= 1 ? Phaser.Textures.FilterMode.NEAREST : Phaser.Textures.FilterMode.LINEAR;
    if (mode === this.#filter) return;
    this.#filter = mode;
    for (const key of this.#artKeys) this.textures.get(key).setFilter(mode);
    for (const key of this.textures.getTextureKeys()) if (key.startsWith('underside.')) this.textures.get(key).setFilter(mode);
  }

  #setZoom(i: number, focus?: { x: number; y: number }, instant = false): void {
    const cam = this.cameras.main;
    this.#zoomIdx = Phaser.Math.Clamp(i, 0, this.#levels.length - 1);
    const level = this.#levels[this.#zoomIdx] as { name: string; zoom: number };
    // `focus` is a world point to show; the camera centre is worked out from it.
    const selected = this.#selected ? this.#mirlings.get(this.#selected) : undefined;
    const point = focus ?? (level.name === 'Everything' ? undefined : selected?.pos);
    const target = point ? this.#centerFor(point, level.zoom) : level.name === 'Everything' ? this.#everythingCenter(level.zoom) : undefined;
    this.#applyFilter(level.zoom);
    if (instant) {
      cam.setZoom(level.zoom);
      if (target) cam.centerOn(target.x, target.y);
    } else {
      cam.zoomTo(level.zoom, 300, 'Sine.easeInOut', true);
      if (target) cam.pan(target.x, target.y, 300, 'Sine.easeInOut', true);
    }
    this.#options.onZoom?.(level.name, this.#zoomIdx < this.#levels.length - 1, this.#zoomIdx > 0);
  }

  #onResize(size: Phaser.Structs.Size): void {
    const cam = this.cameras.main;
    cam.setSize(size.width, size.height);
    if (!this.#sections.length) return;
    const name = this.#levels[this.#zoomIdx]?.name;
    this.#computeZoomLevels();
    const idx = this.#levels.findIndex((l) => l.name === name);
    this.#zoomIdx = idx >= 0 ? idx : Math.min(this.#zoomIdx, this.#levels.length - 1);
    this.#setZoom(this.#zoomIdx, undefined, true);
  }

  // -- build mode, inside --

  #itemLook(kind: ItemKind): { key: string; ox: number; oy: number; drop: number; flat: boolean } {
    const A = this.#art.scale;
    const drop = ((ITEM_DROP[kind] ?? 0) + (onWater(kind) ? WATER_DROP : 0)) * A;
    const flat = FLAT.has(kind);
    if (kind === 'tree' || kind === 'tree-apple') return { key: names.tree(kind === 'tree-apple'), ox: 0.5, oy: 1, drop, flat };
    const key = names.item(kind as Decoration);
    const a = this.#art.anchor(key);
    return { key, ox: a.ox, oy: a.oy, drop, flat };
  }

  // A layout changed: the ground is laid again and the buildings go to their places, while
  // mirlings carry on from wherever they are.
  #rearrange(): void {
    this.#buildGround(false);
    const changedPonds = new Set<Section>();
    for (const sec of this.#sections) {
      const placed = this.#placements.get(sec.name) ?? [];
      for (const b of sec.buildings) {
        const p = placed.find((x) => x.id === b.id);
        if (!p) continue;
        const { x, y } = this.#tileXY(p.c, p.r);
        Object.assign(b, { c: p.c, r: p.r, x, y, style: p.style });
        b.img.setPosition(x, y).setDepth(y);
        this.#fitBuilding(b);
      }
      for (const b of sec.buildings) {
        b.spots = spotsAround(b, this.#walkable);
        b.door = b.spots[0] ?? b;
      }
      // Play pieces taken away lose their ropes. Anyone on a piece moved or taken away, or floating on a
      // pond I dug out or filled in, finds something else to do.
      const old = sec.play;
      sec.play = this.#playgroundOf(sec.i, old);
      for (const sw of old.swings) if (!sec.play.swings.includes(sw)) sw.ropes.destroy();
      const tiles = (pond: Spot[]) => pond.map((s) => `${s.c},${s.r}`).sort().join(' ');
      if (tiles(old.pond) !== tiles(sec.play.pond)) changedPonds.add(sec);
    }
    for (const col of this.#mirlings.values()) {
      const p = col.play;
      const pg = col.sec.play;
      const gone = (p?.kind === 'swing' && !pg.swings.includes(p.frame)) || ((p?.kind === 'slide' || p?.kind === 'bounce') && !pg.slides.includes(p.ride) && !pg.trampolines.includes(p.ride))
        || (p?.kind === 'float' && changedPonds.has(col.sec));
      if (!gone) continue;
      this.#stopActing(col);
      if (col.status === 'my-turn') this.#chill(col);
    }
  }

  #setLayout(name: string, layout: SectionLayout, remember: boolean): void {
    if (remember) this.#undo.push({ name, layout: this.#layouts[name] });
    this.#layouts = { ...this.#layouts, [name]: layout };
    this.#rearrange();
    this.#options.onLayout?.(name, layout);
  }

  #tileUnder(p: Phaser.Input.Pointer): Spot {
    const point = this.cameras.main.getWorldPoint(p.x, p.y);
    const { w, h } = this.#art.tile;
    const u = point.x / (w / 2);
    const v = point.y / (h / 2);
    return { c: Math.round((u + v) / 2), r: Math.round((v - u) / 2) };
  }

  #target(spot: Spot): Target | null {
    const cell = this.#cells.get(`${spot.c},${spot.r}`);
    const where = cell ? placeOf(spot.c, spot.r, this.#sections.length, cell.by) : null;
    const sec = where ? this.#sections[where.i] : undefined;
    if (!where || !sec || !cell) return null;
    return { sec, where, cell, building: sec.buildings.find((b) => b.c === spot.c && b.r === spot.r), piece: pieceAt(cell) };
  }

  /** What the current tool would do on a tile: a new layout, a building or play piece picked up, or why not. */
  #outcome(t: Target): Outcome | { pick: Building | PickedPiece } {
    const { tool, picked } = this.#build;
    const layout = this.#layouts[t.sec.name];
    if (tool === 'move') {
      if (!picked) {
        if (t.building) return { pick: t.building };
        return t.piece ? { pick: { piece: t.piece, c: t.cell.c, r: t.cell.r, where: t.where } } : { refused: 'Click a building or a play piece to pick it up.' };
      }
      if ('piece' in picked) {
        if (picked.c === t.cell.c && picked.r === t.cell.r) return { pick: picked };
        if (t.where.i !== picked.where.i) return { refused: "A play piece stays in its own project's part of the island." };
        return movePiece(layout, picked.piece, picked.where.place, t.cell, t.where.place);
      }
      if (t.building === picked) return { pick: picked };
      if (t.where.own && !t.sec.buildings.includes(picked)) return { refused: "A building stays in its own project's section." };
      return move(layout, buildingIndex(picked), t.cell, t.where);
    }
    if (tool === 'restyle') {
      if (t.building?.type !== 'house') return { refused: 'Only houses come in other styles.' };
      return restyle(layout, buildingIndex(t.building), t.building.style);
    }
    if (t.building) return { refused: tool === 'remove' ? 'Buildings stay, since they stand for real work. Move them instead.' : 'A building stands here.' };
    return edit(layout, tool, t.cell, t.where.place, t.where.own);
  }

  // The building or play piece a change would leave with no way in, if any. The island is laid again
  // with the new layout and checked against how it stands now, so a corner that was already shut off
  // doesn't stop me.
  #cutsOff(name: string, layout: SectionLayout): string | null {
    const before = new Set(unreachable(this.#cells, destinations(this.#cells, [...this.#placements.values()])).map((d) => d.key));
    const templates = this.#order.map((n) => this.#templates.get(n) ?? 'code');
    const cells = generateCells(templates);
    const layouts = { ...this.#layouts, [name]: layout };
    const placements = this.#order.map((n, i) => arrange(cells, i, templates[i] ?? 'code', layouts[n]));
    return unreachable(cells, destinations(cells, placements)).find((d) => !before.has(d.key))?.label ?? null;
  }

  #buildHover(p: Phaser.Input.Pointer): void {
    const spot = this.#tileUnder(p);
    const t = this.#target(spot);
    const result = t ? this.#outcome(t) : null;
    const ok = Boolean(result && !('refused' in result));
    if (!this.#cells.has(`${spot.c},${spot.r}`)) {
      this.#cursor.setVisible(false);
      this.#ghost.setVisible(false);
      return;
    }
    const { x, y } = this.#tileXY(spot.c, spot.r);
    this.#cursor.setTexture(names.cursor(ok)).setPosition(x, y).setDepth(-100000 + spot.c + spot.r + 0.5).setVisible(true);
    const { tool } = this.#build;
    if (ok && isItem(tool)) {
      const look = this.#itemLook(tool);
      this.#ghost.setTexture(look.key).setOrigin(look.ox, look.oy).setPosition(x, y + look.drop).setDepth(y + look.drop + 0.5).setVisible(true);
    } else if (ok && isPiece(tool)) {
      const a = this.#art.anchor(names.play(tool));
      this.#ghost.setTexture(names.play(tool)).setOrigin(a.ox, a.oy).setPosition(x, y).setDepth(y + 0.5).setVisible(true);
    } else {
      this.#ghost.setVisible(false);
    }
  }

  #buildClick(p: Phaser.Input.Pointer): void {
    const t = this.#target(this.#tileUnder(p));
    if (!t) return this.#hint("That's the sky. Build on the island's land and water.");
    const result = this.#outcome(t);
    if ('pick' in result) return this.#pick(result.pick === this.#build.picked ? null : result.pick);
    if ('refused' in result) return this.#hint(result.refused);
    const shut = this.#cutsOff(t.sec.name, result.layout);
    if (shut) return this.#hint(`That would cut off the ${shut}. Leave it a way in.`);
    this.#pick(null);
    this.#setLayout(t.sec.name, result.layout, true);
    this.#hint(this.#toolHint());
  }

  #pick(b: Building | PickedPiece | null): void {
    const imageOf = (p: Building | PickedPiece) => ('piece' in p ? this.#pieceImages.get(`${p.c},${p.r}`) : p.img);
    if (this.#build.picked) imageOf(this.#build.picked)?.clearTint();
    this.#build.picked = b;
    if (b) imageOf(b)?.setTint(0xffe08a);
    const label = b && ('piece' in b ? PIECES[b.piece].label.toLowerCase() : BUILDING_LABEL[b.type]);
    if (label) this.#hint(`Now click a free tile for the ${label}, or click it again to put it back.`);
    else if (this.#build.on) this.#hint(this.#toolHint());
  }

  #hint(text: string): void {
    this.#options.onBuildHint?.(text);
  }

  #toolHint(): string {
    const { tool } = this.#build;
    if (tool === 'move') return 'Click a building or a play piece, then a free tile. Buildings stay on their own ground.';
    if (tool === 'restyle') return 'Click a house to change its style.';
    if (tool === 'remove') return 'Click a tree, plant, decoration or play piece to take it away.';
    if (tool === 'water') return 'Click land to dig a pond. Paint path, grass or flowers on a pond to fill it in.';
    if (tool === 'path' || tool === 'grass' || tool === 'flowers') return `Click tiles anywhere on the island to make them ${tool}.`;
    if (isPiece(tool)) return `Click a free tile anywhere on the island to put up ${tool === 'swings' ? 'swings' : `a ${tool}`}. Mirlings play there while they wait for you.`;
    if (onWater(tool)) return tool === 'boat' ? 'Click a stream or pond to put a boat on it.' : 'Click a stream or pond to float lily pads on it.';
    const label = ITEMS[tool].label.toLowerCase();
    const what = label.endsWith('s') ? label : `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
    return `Click a free tile anywhere on the island to place ${what}.`;
  }

  #setupInput(): void {
    const cam = this.cameras.main;
    this.input.topOnly = false;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      cam.panEffect.reset();
      this.#drag = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, moved: false };
    });
    this.input.on('gameout', () => {
      this.#cursor.setVisible(false);
      this.#ghost.setVisible(false);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.#build.on && !p.isDown) this.#buildHover(p);
      if (!this.#drag || !p.isDown) return;
      const dx = p.x - this.#drag.x;
      const dy = p.y - this.#drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6 * DPR()) this.#drag.moved = true;
      if (this.#drag.moved) {
        cam.scrollX = this.#drag.sx - dx / cam.zoom;
        cam.scrollY = this.#drag.sy - dy / cam.zoom;
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (this.#drag && !this.#drag.moved && this.#build.on) {
        this.#buildClick(p);
        this.#buildHover(p);
      } else if (this.#drag && !this.#drag.moved) {
        const id = over.map((o) => o.getData('session') as string | undefined).find(Boolean);
        const section = over.map((o) => o.getData('section') as string | undefined).find(Boolean);
        if (id) this.#options.onSelect(id);
        else if (section) this.#options.onSection?.(section);
      }
      this.#drag = null;
    });
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      if (this.time.now - this.#lastWheel < 350) return;
      this.#lastWheel = this.time.now;
      this.#setZoom(this.#zoomIdx + (dy > 0 ? -1 : 1));
    });
  }
}
