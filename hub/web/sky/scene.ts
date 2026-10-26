// The sky: one island, a hedged section per project, a mirling per live session acting out its
// status (decisions 12 and 13). Sessions come from the hub; nothing here is simulated.

import type { MiraEvent } from '../../../contracts/src/index.ts';
import { sessionLabel, type BoardSession } from '../shared/format.ts';
import { ACCENT_COLOUR, ACCENTS, MAX_LEVEL, names, type Accent, type Art, type HouseStyle, type Palette } from './art.ts';
import { findPath, generateCells, hash, SEC, sectionOrigin, spotsAround, templateBuildings, type BuildingType, type Cell, type Spot, type Template } from './world.ts';

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
}

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
}

// Tools that read go to the library; everything else is made in the workshop.
const READING = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead']);
const HOUSE_STYLES: HouseStyle[] = ['brick', 'timber', 'stone'];
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
  #forget = new Set<string>();
  #order: string[] = [];
  #templates = new Map<string, Template>();
  #sections: Section[] = [];
  #mirlings = new Map<string, Mirling>();
  #cells = new Map<string, Cell>();
  #ground: Phaser.GameObjects.GameObject[] = [];
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

  /** Takes a removed project off the island; the other sections close up behind it. */
  forget(name: string): void {
    this.#forget.add(name);
    if (this.#ready) this.#apply();
  }

  /** Sends a mirling to the library or workshop for the tool it just started. */
  event(e: MiraEvent): void {
    if (!this.#ready || e.type !== 'tool.started' || e.actor.kind !== 'session') return;
    const col = this.#mirlings.get(e.actor.id);
    const tool = e.detail?.tool;
    if (!col || col.removed || !tool) return;
    this.#floatText(col, tool);
    if (col.status !== 'working') return;
    const work = this.#workFor(col.sec, tool);
    if (work === col.work) return;
    col.work = work;
    this.#walkTo(col, pickOne(work.spots), () => this.#wander(col));
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
    const { creature, beacon, bubble } = this.#art.sizes;
    const beaconScale = Math.max(1, (18 * d) / (beacon * zoom));
    const bubbleScale = Math.max(1, (12 * d) / (bubble * zoom));
    const A = this.#art.scale;
    for (const col of this.#mirlings.values()) {
      const beat = Math.floor(time / 170 + col.phase * 2) % 2;
      const key = names.creature(col.palette, col.moving && beat ? 'b' : 'a');
      if (col.sprite.texture.key !== key) col.sprite.setTexture(key);
      const x = Math.round(col.pos.x);
      const y = Math.round(col.pos.y) - (col.moving && beat && !reduceMotion ? A : 0);
      col.sprite.setFlipX(col.facing < 0).setPosition(x, y).setDepth(col.pos.y);
      const head = y - creature;
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
    const selected = this.#selected ? this.#mirlings.get(this.#selected) : undefined;
    if (selected) this.#selectMark.setPosition(Math.round(selected.pos.x), Math.round(selected.pos.y)).setDepth(selected.pos.y - 0.5);
    // A mirling under the pointer names itself first, then a building, then the mirling whose story is open.
    const pointed = this.#mirlings.get(this.#hovered ?? '');
    const building = pointed ? null : this.#hoveredBuilding;
    const labelled = pointed ?? (building ? undefined : selected);
    this.#hoverLabel.setVisible(Boolean(labelled || building));
    if (labelled) {
      this.#hoverLabel.setText(labelled.title).setScale(ui).setPosition(Math.round(labelled.pos.x), Math.round(labelled.pos.y) - creature - (labelled.marks.beacon ? 22 * d / zoom + 4 * A : 4 * A));
    } else if (building) {
      this.#hoverLabel.setText(this.#buildingSays(building)).setScale(ui).setPosition(building.x, building.top - 2 * A);
    }
    for (const sec of this.#sections) {
      sec.summary.setScale(ui).setPosition(sec.anchor.x, sec.anchor.y);
      sec.label.setScale(ui).setPosition(sec.anchor.x, sec.anchor.y - sec.summary.displayHeight);
    }
  }

  // -- keeping up with the hub --

  #apply(): void {
    const data = this.#pending;
    if (!data) return;
    const listed = new Set([...data.systems, ...data.sessions.map((s) => s.system)]);
    const dropped = [...this.#forget].filter((name) => !listed.has(name));
    if (dropped.length) {
      // Removing a section moves the ones after it, so the island is laid out again.
      this.#clear();
      this.#order = this.#order.filter((name) => !dropped.includes(name));
      for (const name of dropped) this.#forget.delete(name);
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
      sec.label.destroy();
      sec.summary.destroy();
    }
    this.#sections = [];
  }

  // New projects add sections at the edge; the ground is redrawn, while existing buildings and mirlings stay put.
  #grow(from: number): void {
    const animate = from > 0;
    this.#buildGround(animate);
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
    this.#cells = generateCells(this.#order.map((name) => this.#templates.get(name) ?? 'code'));
    const { h, side } = this.#art.tile;
    const A = this.#art.scale;
    const fresh: Image[] = [];
    [...this.#cells.values()].sort((a, b) => a.c + a.r - (b.c + b.r)).forEach((cell) => {
      const { x, y } = this.#tileXY(cell.c, cell.r);
      const kind = cell.ch === 'p' ? 'path' : cell.ch === 'w' ? 'water' : cell.ch === 'f' ? 'flowers' : (`grass${Math.floor(hash(cell.c, cell.r, 3) * 3)}` as 'grass0');
      const tile = this.add.image(x, y, names.tile(kind)).setOrigin(0.5, h / 2 / (h + side)).setDepth(-100000 + cell.c + cell.r);
      this.#ground.push(tile);
      let deco: Image | null = null;
      if (cell.ch === 'h' && cell.section !== null) {
        const key = names.hedge(ACCENTS[cell.section % ACCENTS.length] as Accent);
        const a = this.#art.anchor(key);
        deco = this.add.image(x, y, key).setOrigin(a.ox, a.oy).setDepth(y);
      } else if (cell.ch === 'T') {
        deco = this.add.image(x, y + 3 * A, names.tree(hash(cell.c, cell.r, 4) < 0.4)).setOrigin(0.5, 1).setDepth(y + 3 * A);
      }
      if (deco) this.#ground.push(deco);
      if (animate && !known.has(`${cell.c},${cell.r}`)) fresh.push(tile, ...(deco ? [deco] : []));
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
    const sec: Section = { i, name, accent, template, buildings: [], houses: [], anchor: { x: 0, y: 0 }, label: null as unknown as Text, summary: null as unknown as Text };
    for (const tb of templateBuildings(i, template)) {
      const { x, y } = this.#tileXY(tb.c, tb.r);
      const style = HOUSE_STYLES[Math.floor(hash(tb.c, tb.r, 5) * HOUSE_STYLES.length)] as HouseStyle;
      const img = this.add.image(x, y, names.select).setDepth(y);
      const spots = spotsAround(tb, this.#walkable);
      const b: Building = { ...tb, x, y, top: y, img, spots, door: spots[0] ?? tb, style, residents: 0, level: 1 };
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
    sec.label = this.#label(name.toUpperCase(), { fontFamily: '"Pixelify Sans", monospace', fontSize: '14px', color: ACCENT_COLOUR[accent], backgroundColor: '#0b0d1acc', padding: { x: 5, y: 2 } });
    for (const text of [sec.label, sec.summary]) text.setInteractive({ useHandCursor: true }).setData('section', name);
    this.#sections.push(sec);
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
    const cell = s.status === 'working' ? pickOne(work.spots.length ? work.spots : [work.door]) : home.door;
    const pos = this.#spotXY(cell);
    const palette: Palette = 'y';
    const sprite = this.add.image(pos.x, pos.y, names.creature(palette, 'a')).setOrigin(0.5, 1);
    const w = sprite.width;
    const h = sprite.height;
    sprite.setInteractive({ hitArea: new Phaser.Geom.Rectangle(-w * 0.6, -h * 0.7, w * 2.2, h * 1.9), hitAreaCallback: Phaser.Geom.Rectangle.Contains, useHandCursor: true });
    sprite.setData('session', s.id);
    sprite.on('pointerover', () => { this.#hovered = s.id; });
    sprite.on('pointerout', () => { if (this.#hovered === s.id) this.#hovered = null; });
    const col: Mirling = {
      id: s.id, title: sessionLabel(s), sec, home, work, cell, pos, sprite, status: null, base: palette, palette,
      walkId: 0, moving: false, facing: 1, phase: Math.random(), marks: {}, helpers: new Map(), removed: false,
    };
    home.residents += 1;
    this.#fitBuilding(home);
    this.#mirlings.set(s.id, col);
    if (!reduceMotion) {
      sprite.setAlpha(0);
      this.tweens.add({ targets: sprite, alpha: 1, duration: 500 });
    }
    this.#setStatus(col, (s.status ?? null) as Status | null);
    return col;
  }

  #walkTo(col: Mirling, target: Spot, done?: () => void): void {
    const id = ++col.walkId;
    const path = findPath(this.#walkable, col.cell, target);
    const A = this.#art.scale;
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
      this.tweens.add({ targets: col.pos, x: to.x, y: to.y, duration: Math.max(140, (dist / A) * 26), onComplete: () => { col.cell = next; step(); } });
    };
    step();
  }

  #wander(col: Mirling): void {
    const id = col.walkId;
    this.time.delayedCall(rand(2500, 5000), () => {
      if (col.walkId !== id || col.status !== 'working' || col.removed || !col.work.spots.length) return;
      this.#walkTo(col, pickOne(col.work.spots), () => this.#wander(col));
    });
  }

  #setStatus(col: Mirling, status: Status | null): void {
    col.status = status;
    col.walkId += 1;
    this.tweens.killTweensOf(col.pos);
    col.moving = false;
    this.#clearMarks(col);
    col.palette = status === 'failed' ? 'g' : col.base;
    if (status === 'working') {
      const spots = col.work.spots.length ? col.work.spots : [col.work.door];
      this.#walkTo(col, pickOne(spots), () => this.#wander(col));
    } else if (status === 'needs-me') {
      this.#addBeacon(col);
    } else if (status === 'failed') {
      this.#addSmoke(col);
    } else if (status === 'ended') {
      this.#walkTo(col, col.home.door, () => this.#retire(col, false));
    } else {
      // My turn, or not known yet: wait by the door at home.
      this.#walkTo(col, col.home.door, () => { if (status === 'my-turn' && col.status === 'my-turn') this.#addBubble(col); });
    }
    this.#refreshSummaries();
  }

  // Goes inside and turns the light off; `now` skips the fade, for a session that moved to another project.
  #retire(col: Mirling, now: boolean): void {
    if (col.removed) return;
    col.removed = true;
    col.walkId += 1;
    this.#clearMarks(col);
    for (const h of col.helpers.values()) h.sprite.destroy();
    col.helpers.clear();
    this.tweens.killTweensOf(col.pos);
    if (now || reduceMotion) col.sprite.destroy();
    else this.tweens.add({ targets: col.sprite, alpha: 0, duration: 500, onComplete: () => col.sprite.destroy() });
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
    const label = this.add.text(x, y, text, { fontFamily: '"Pixelify Sans", monospace', fontSize: '12px', color, resolution: DPR() })
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

  #setupInput(): void {
    const cam = this.cameras.main;
    this.input.topOnly = false;
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      cam.panEffect.reset();
      this.#drag = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, moved: false };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!this.#drag || !p.isDown) return;
      const dx = p.x - this.#drag.x;
      const dy = p.y - this.#drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 6 * DPR()) this.#drag.moved = true;
      if (this.#drag.moved) {
        cam.scrollX = this.#drag.sx - dx / cam.zoom;
        cam.scrollY = this.#drag.sy - dy / cam.zoom;
      }
    });
    this.input.on('pointerup', (_p: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
      if (this.#drag && !this.#drag.moved) {
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
