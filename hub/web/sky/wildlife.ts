// Wildlife on the island (decision 63): birds crossing by day, butterflies about the flowers in spring
// and summer, fish jumping in the streams and ponds, clouds drifting under the island, smoke rising
// from campfires, and fireflies on summer nights. It's all for show: nothing here stands for work.

import { names, type Art } from './art.ts';
import type { Daylight, Season } from './daylight.ts';
import type { Cell } from './world.ts';

type Image = Phaser.GameObjects.Image;
type Point = { x: number; y: number };

/** What wildlife needs of the scene it lives in. */
export interface WildHost {
  scene: Phaser.Scene;
  art: Art;
  cells(): Map<string, Cell>;
  tileXY(c: number, r: number): Point;
  /** The island's bounds, in world pixels. */
  fit(): { x: number; y: number; w: number; h: number };
  daylight(): Daylight;
  season(): Season;
  inSky<T extends Phaser.GameObjects.GameObject>(obj: T): T;
  overIsland<T extends Phaser.GameObjects.GameObject>(obj: T): T;
  /** A sound from a point on the island, if it's on screen (decision 69). */
  sound(name: 'splash' | 'birds', x: number): void;
}

interface Flier {
  img: Image;
  home: Point;
  to: Point;
  phase: number;
  /** When it moves on to another spot. */
  until: number;
  leaving?: boolean;
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pickOne = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)] as T;

const BUTTERFLY_TINTS = [0xffd34d, 0xff9ec7, 0x9ec7ff, 0xffffff, 0xffa65a];
const MAX_BUTTERFLIES = 6;
const MAX_FIREFLIES = 14;
const MAX_FIRES = 8;
const CLOUDS = 6;
const PLANTS = new Set(['flowerbed', 'sunflowers', 'shrub', 'flower-bush', 'hedge']);

export class Wildlife {
  #host: WildHost;
  #flowers: Point[] = [];
  #water: Point[] = [];
  #fires: Point[] = [];
  #grass: Point[] = [];
  #birds: Array<{ img: Image; phase: number }> = [];
  #butterflies: Flier[] = [];
  #fireflies: Flier[] = [];
  #clouds: Array<{ img: Image; speed: number }> = [];
  #nextBirds = 8000;
  #nextFish = 3000;
  #nextSmoke = 0;

  constructor(host: WildHost) {
    this.#host = host;
  }

  /** The island changed shape: finds its flowers, water, fires and grass again. */
  relayout(): void {
    const at = (cell: Cell) => this.#host.tileXY(cell.c, cell.r);
    const cells = [...this.#host.cells().values()];
    this.#flowers = cells.filter((c) => c.ch === 'f' || (c.item && PLANTS.has(c.item))).map(at);
    this.#water = cells.filter((c) => c.ch === 'w').map(at);
    this.#fires = cells.filter((c) => c.item === 'campfire').map(at).slice(0, MAX_FIRES);
    this.#grass = cells.filter((c) => c.ch === 'g' && c.section !== null).map(at);
    // Fliers whose flowers or grass have gone settle somewhere else.
    for (const f of this.#butterflies) if (this.#flowers.length) f.to = this.#near(this.#flowers, f.home);
    for (const f of this.#fireflies) if (this.#grass.length) f.to = this.#near(this.#grass, f.home);
    if (!this.#clouds.length && !reduceMotion) this.#makeClouds();
  }

  update(time: number, delta: number): void {
    if (reduceMotion) return;
    const light = this.#host.daylight();
    const season = this.#host.season();
    const A = this.#host.art.scale;
    if (time >= this.#nextBirds) {
      if (light.night < 0.3) this.#flock();
      this.#nextBirds = time + rand(20000, 45000);
    }
    if (time >= this.#nextFish && this.#water.length) {
      this.#jump();
      this.#nextFish = time + rand(4000, 9000);
    }
    if (time >= this.#nextSmoke) {
      for (const fire of this.#fires) this.#puff(fire);
      this.#nextSmoke = time + 900;
    }
    for (const bird of this.#birds) bird.img.setTexture(names.bird(Math.floor(time / 160 + bird.phase * 2) % 2 ? 'a' : 'b'));
    // Butterflies by day in spring and summer, fireflies on summer nights.
    const butterflies = light.night < 0.3 && (season === 'spring' || season === 'summer') ? Math.min(MAX_BUTTERFLIES, Math.ceil(this.#flowers.length / 2)) : 0;
    const fireflies = light.night > 0.6 && season === 'summer' ? Math.min(MAX_FIREFLIES, this.#grass.length) : 0;
    this.#keep(this.#butterflies, butterflies, () => this.#butterfly(time));
    this.#keep(this.#fireflies, fireflies, () => this.#firefly(time));
    const settle = Math.min(1, delta * 0.0006);
    for (const f of this.#butterflies) {
      if (time > f.until && this.#flowers.length) {
        f.to = this.#near(this.#flowers, f.home);
        f.until = time + rand(8000, 20000);
      }
      f.home.x += (f.to.x - f.home.x) * settle;
      f.home.y += (f.to.y - f.home.y) * settle;
      const x = f.home.x + Math.sin(time / 900 + f.phase * 6) * 6 * A;
      const y = f.home.y - 6 * A + Math.sin(time / 600 + f.phase * 9) * 3 * A;
      f.img.setPosition(x, y).setDepth(f.home.y + 10 * A).setTexture(names.butterfly(Math.floor(time / 90 + f.phase * 3) % 2 ? 'a' : 'b'));
    }
    for (const f of this.#fireflies) {
      if (time > f.until && this.#grass.length) {
        f.to = this.#near(this.#grass, f.home);
        f.until = time + rand(10000, 25000);
      }
      f.home.x += (f.to.x - f.home.x) * settle * 0.5;
      f.home.y += (f.to.y - f.home.y) * settle * 0.5;
      const blink = Math.max(0, Math.sin(time / 800 + f.phase * 13)) ** 2;
      f.img.setPosition(f.home.x + Math.sin(time / 1500 + f.phase * 4) * 5 * A, f.home.y - 4 * A + Math.sin(time / 1100 + f.phase * 7) * 3 * A);
      if (!f.leaving) f.img.setAlpha(blink * light.night);
    }
    // Clouds drift under the island and come round again, in the light of the hour.
    const fit = this.#host.fit();
    const [r, g, b] = light.tint;
    const tint = Phaser.Display.Color.GetColor(Math.round(255 * r), Math.round(255 * g), Math.round(255 * b));
    for (const cloud of this.#clouds) {
      cloud.img.x += (cloud.speed * delta) / 1000;
      if (cloud.img.x > fit.x + fit.w + cloud.img.displayWidth) cloud.img.x = fit.x - cloud.img.displayWidth;
      cloud.img.setTint(tint).setAlpha(0.45 - 0.2 * light.night);
    }
  }

  // -- birds, fish and smoke --

  /** Three to five birds in a V cross the island, one way or the other. */
  #flock(): void {
    const { scene, art } = this.#host;
    const A = art.scale;
    const fit = this.#host.fit();
    const way = Math.random() < 0.5 ? 1 : -1;
    const start = way > 0 ? fit.x - 30 * A : fit.x + fit.w + 30 * A;
    const y = fit.y + rand(0.05, 0.45) * fit.h;
    const count = 3 + Math.floor(Math.random() * 3);
    const duration = ((fit.w + 60 * A) / (45 * A)) * 1000;
    // They call as they cross the middle of the island.
    scene.time.delayedCall(duration / 2, () => this.#host.sound('birds', fit.x + fit.w / 2));
    for (let i = 0; i < count; i++) {
      const back = Math.ceil(i / 2) * 9 * A;
      const side = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 6 * A;
      const img = scene.add.image(start - way * back, y + side, names.bird('a')).setDepth(350000).setScale(A * 0.75);
      const bird = { img, phase: Math.random() };
      this.#birds.push(bird);
      scene.tweens.add({
        targets: img, x: img.x + way * (fit.w + 60 * A), y: img.y - rand(5, 20) * A, duration,
        onComplete: () => {
          img.destroy();
          this.#birds = this.#birds.filter((b) => b !== bird);
        },
      });
    }
  }

  /** A goldfish leaps out of the water and back in, with a splash at each end. */
  #jump(): void {
    const { scene, art } = this.#host;
    const A = art.scale;
    const at = pickOne(this.#water);
    const way = Math.random() < 0.5 ? 1 : -1;
    const from = { x: at.x + rand(-6, 6) * A, y: at.y + 3 * A };
    const fish = scene.add.image(from.x, from.y, names.fish).setDepth(from.y + 1).setFlipX(way < 0).setScale(A / 2 + 0.5);
    const t = { k: 0 };
    this.#splash(from);
    this.#host.sound('splash', from.x);
    scene.tweens.add({
      targets: t, k: 1, duration: 650, ease: 'Linear',
      onUpdate: () => fish.setPosition(from.x + way * 8 * A * t.k, from.y - Math.sin(Math.PI * t.k) * 9 * A).setRotation(way * (t.k - 0.5) * 1.4),
      onComplete: () => {
        fish.destroy();
        this.#splash({ x: from.x + way * 8 * A, y: from.y });
      },
    });
  }

  #splash(at: Point): void {
    const { scene, art } = this.#host;
    const ring = scene.add.image(at.x, at.y, names.splash(0)).setDepth(at.y).setScale(art.scale / 2 + 0.5);
    scene.time.delayedCall(140, () => ring.setTexture(names.splash(1)));
    scene.tweens.add({ targets: ring, alpha: 0, delay: 140, duration: 420, onComplete: () => ring.destroy() });
  }

  #puff(fire: Point): void {
    const { scene, art } = this.#host;
    const A = art.scale;
    const puff = scene.add.image(fire.x + rand(-1, 1) * A, fire.y - 5 * A, names.smoke).setDepth(fire.y + 1).setScale(0.5).setAlpha(0.7);
    scene.tweens.add({ targets: puff, x: puff.x + rand(-3, 3) * A, y: puff.y - 16 * A, scale: 1.1, alpha: 0, duration: 2400, onComplete: () => puff.destroy() });
  }

  // -- butterflies, fireflies and clouds --

  /** Brings fliers in or sends them off, one at a time, until there are as many as wanted. */
  #keep(fliers: Flier[], wanted: number, make: () => Flier | null): void {
    const staying = fliers.filter((f) => !f.leaving);
    if (staying.length < wanted) {
      const f = make();
      if (f) fliers.push(f);
    } else if (staying.length > wanted) {
      const f = staying[0] as Flier;
      f.leaving = true;
      this.#host.scene.tweens.add({
        targets: f.img, alpha: 0, duration: 1500,
        onComplete: () => {
          f.img.destroy();
          fliers.splice(fliers.indexOf(f), 1);
        },
      });
    }
  }

  #butterfly(time: number): Flier | null {
    if (!this.#flowers.length) return null;
    const home = { ...pickOne(this.#flowers) };
    const img = this.#host.scene.add.image(home.x, home.y, names.butterfly('a')).setTint(pickOne(BUTTERFLY_TINTS)).setScale(this.#host.art.scale * 0.75).setAlpha(0);
    this.#host.scene.tweens.add({ targets: img, alpha: 1, duration: 1200 });
    return { img, home, to: { ...home }, phase: Math.random(), until: time + rand(8000, 20000) };
  }

  #firefly(time: number): Flier | null {
    if (!this.#grass.length) return null;
    const home = { ...pickOne(this.#grass) };
    // Over the island, so night doesn't shade it, and added to what's under it, so it glows.
    const img = this.#host.overIsland(this.#host.scene.add.image(home.x, home.y, names.firefly).setBlendMode(Phaser.BlendModes.ADD).setDepth(400001).setScale(this.#host.art.scale).setAlpha(0));
    return { img, home, to: { ...home }, phase: Math.random(), until: time + rand(10000, 25000) };
  }

  /** Somewhere within a few tiles of a point, or anywhere if there's nowhere that near. */
  #near(spots: Point[], from: Point): Point {
    const reach = 4 * this.#host.art.tile.w;
    const close = spots.filter((s) => Math.abs(s.x - from.x) + Math.abs(s.y - from.y) < reach);
    return { ...pickOne(close.length ? close : spots) };
  }

  #makeClouds(): void {
    const { scene, art } = this.#host;
    const fit = this.#host.fit();
    for (let i = 0; i < CLOUDS; i++) {
      const img = this.#host.inSky(scene.add.image(fit.x + rand(0, 1) * fit.w, fit.y + rand(0.55, 1.1) * fit.h, names.cloud(i % 3)).setScale(art.scale * rand(0.9, 1.4)).setDepth(-900000));
      this.#clouds.push({ img, speed: rand(4, 9) * art.scale });
    }
  }
}
