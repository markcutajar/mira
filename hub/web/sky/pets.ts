// Animals on the island (decision 71): a dog, a cat or a capybara I placed, wandering round the tile it
// calls home. Dogs roam furthest and now and then trot after a mirling on the move; cats keep closer
// and nap; capybaras amble, and bathe in a pond or stream nearby. At bedtime they all curl up at home.
// Like the wildlife, none of it stands for work.

import { names, type Animal, type AnimalPose, type Art } from './art.ts';
import type { Daylight } from './daylight.ts';
import { findPath, hash, type Cell, type Spot } from './world.ts';

type Image = Phaser.GameObjects.Image;
type Point = { x: number; y: number };

/** What the animals need of the scene they live in. */
export interface PetHost {
  scene: Phaser.Scene;
  art: Art;
  cells(): Map<string, Cell>;
  walkable(c: number, r: number): boolean;
  /** A point to stand on a tile, a little off its middle. */
  spotXY(cell: Spot): Point;
  tileXY(c: number, r: number): Point;
  /** How far water lies below the ground, in pixels. */
  waterDrop: number;
  daylight(): Daylight;
  /** Where the mirlings are, for a dog to follow one on the move. */
  mirlings(): Array<{ cell: Spot; moving: boolean }>;
  overIsland<T extends Phaser.GameObjects.GameObject>(obj: T): T;
}

export interface Pet {
  kind: Animal;
  /** The tile it calls home, by its key, as the island laid it. */
  key: string;
  home: Spot;
  cell: Spot;
  pos: Point;
  coat: number;
  sprite: Image;
  pose: AnimalPose;
  moving: boolean;
  facing: 1 | -1;
  phase: number;
  /** How high it is off the ground in a hop, 0 to 1. */
  lift: { t: number };
  walkId: number;
  later: Array<{ remove(): unknown }>;
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pickOne = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)] as T;

// How far each wanders from home, in tiles, and how long a step takes, against a mirling's.
const ROAM: Record<Animal, { reach: number; pace: number }> = {
  dog: { reach: 5, pace: 0.75 },
  cat: { reach: 3, pace: 1.1 },
  capybara: { reach: 4, pace: 1.8 },
};

export class Pets {
  #host: PetHost;
  #pets = new Map<string, Pet>();
  #asleep = false;

  constructor(host: PetHost) {
    this.#host = host;
  }

  /** The island changed: an animal for each home that has one, as before where it stayed the same. */
  relayout(): void {
    const homes = new Map<string, Cell>();
    for (const cell of this.#host.cells().values()) if (cell.animal) homes.set(`${cell.c},${cell.r}`, cell);
    for (const [key, pet] of this.#pets) {
      const home = homes.get(key);
      if (home?.animal === pet.kind) continue;
      this.#forget(pet);
      this.#pets.delete(key);
    }
    for (const [key, cell] of homes) {
      if (this.#pets.has(key)) continue;
      const kind = cell.animal as Animal;
      const pos = this.#host.spotXY(cell);
      const coat = Math.floor(hash(cell.c, cell.r, 13) * this.#host.art.animalCoats[kind]);
      const sprite = this.#host.scene.add.image(pos.x, pos.y, names.animal(kind, coat, 'sit')).setOrigin(0.5, 1);
      const pet: Pet = { kind, key, home: { c: cell.c, r: cell.r }, cell: { c: cell.c, r: cell.r }, pos, coat, sprite, pose: 'sit', moving: false, facing: hash(cell.c, cell.r, 14) < 0.5 ? 1 : -1, phase: Math.random(), lift: { t: 0 }, walkId: 0, later: [] };
      this.#pets.set(key, pet);
      if (!reduceMotion) this.#later(pet, rand(500, 3000), () => this.#next(pet));
    }
  }

  update(time: number): void {
    const asleep = this.#host.daylight().asleep;
    if (asleep !== this.#asleep) {
      this.#asleep = asleep;
      for (const pet of this.#pets.values()) this.#restart(pet);
    }
    const A = this.#host.art.scale;
    for (const pet of this.#pets.values()) {
      const step = Math.floor(time / (pet.kind === 'dog' ? 110 : pet.kind === 'cat' ? 140 : 190) + pet.phase * 2) % 2;
      const pose: AnimalPose = pet.moving ? (step ? 'b' : 'a') : pet.pose;
      const key = names.animal(pet.kind, pet.coat, pose);
      if (pet.sprite.texture.key !== key) pet.sprite.setTexture(key);
      const bob = pet.pose === 'swim' && !reduceMotion ? Math.round(Math.sin(time / 700 + pet.phase * 6)) : 0;
      const hop = Math.round(Math.sin(Math.PI * pet.lift.t) * 4 * A);
      pet.sprite.setPosition(Math.round(pet.pos.x), Math.round(pet.pos.y) + bob - hop).setFlipX(pet.facing < 0).setDepth(pet.pos.y);
    }
  }

  /** The animal nearest a point on the island, within reach, if any. */
  at(point: Point, reach = 12 * this.#host.art.scale): Pet | null {
    let best: Pet | null = null;
    let nearest = reach;
    for (const pet of this.#pets.values()) {
      const d = Math.hypot(pet.pos.x - point.x, pet.pos.y - 5 * this.#host.art.scale - point.y);
      if (d < nearest) [best, nearest] = [pet, d];
    }
    return best;
  }

  /** A pat on the head: a little hop, unless it's asleep or bathing. */
  pat(pet: Pet): void {
    if (reduceMotion || pet.pose === 'sleep' || pet.pose === 'swim') return;
    this.#host.scene.tweens.add({ targets: pet.lift, t: { from: 0, to: 1 }, duration: 320, ease: 'Linear', onComplete: () => { pet.lift.t = 0; } });
  }

  // -- what each does next --

  #restart(pet: Pet): void {
    this.#forget(pet, false);
    pet.moving = false;
    if (!reduceMotion) this.#later(pet, rand(200, 2500), () => this.#next(pet));
  }

  #next(pet: Pet): void {
    const again = (ms: number) => this.#later(pet, ms, () => this.#next(pet));
    if (this.#asleep) {
      // Bedtime: home, and curled up until morning.
      return this.#walk(pet, pet.home, () => this.#rest(pet, 'sleep', 60_000));
    }
    const roll = Math.random();
    if (pet.kind === 'dog') {
      const mirling = roll < 0.3 ? this.#movingMirlingNear(pet) : null;
      if (mirling) return this.#walk(pet, mirling, () => this.#rest(pet, 'sit', rand(1500, 3000)));
      if (roll < 0.8) return this.#walk(pet, this.#somewhere(pet), () => this.#rest(pet, 'sit', rand(2000, 5000)));
      return this.#rest(pet, 'sit', rand(3000, 6000));
    }
    if (pet.kind === 'cat') {
      if (roll < 0.4) return this.#rest(pet, 'sleep', rand(10_000, 25_000));
      if (roll < 0.8) return this.#walk(pet, this.#somewhere(pet), () => this.#rest(pet, 'sit', rand(3000, 7000)));
      return this.#rest(pet, 'sit', rand(4000, 8000));
    }
    if (roll < 0.4 && this.#bathe(pet)) return;
    if (roll < 0.8) return this.#walk(pet, this.#somewhere(pet), () => this.#rest(pet, 'sit', rand(4000, 9000)));
    again(rand(5000, 10_000));
    pet.pose = 'sit';
  }

  /** Sits or sleeps where it is for a while, z's rising from a sleeper, then goes on. */
  #rest(pet: Pet, pose: AnimalPose, ms: number): void {
    pet.pose = pose;
    pet.moving = false;
    if (pose === 'sleep' && !reduceMotion) {
      const A = this.#host.art.scale;
      const z = () => {
        if (pet.pose !== 'sleep') return;
        const img = this.#host.overIsland(this.#host.scene.add.image(pet.pos.x + pet.facing * 4 * A, pet.pos.y - 8 * A, names.zzz).setOrigin(0.5, 1).setDepth(500000).setScale(0.5));
        this.#host.scene.tweens.add({ targets: img, x: img.x + pet.facing * 4 * A, y: img.y - 8 * A, alpha: 0, scale: 0.9, duration: 2000, onComplete: () => img.destroy() });
      };
      pet.later.push(this.#host.scene.time.addEvent({ delay: 2200, loop: true, callback: z }));
    }
    this.#later(pet, ms, () => this.#next(pet));
  }

  /** A capybara's bath: to a bank beside water near home, into the water up to its back, and out again. */
  #bathe(pet: Pet): boolean {
    const cells = this.#host.cells();
    const near = (cell: Cell) => Math.max(Math.abs(cell.c - pet.home.c), Math.abs(cell.r - pet.home.r)) <= ROAM.capybara.reach + 1;
    const banks: Array<{ bank: Spot; water: Spot }> = [];
    for (const cell of cells.values()) {
      if (cell.ch !== 'w' || !near(cell)) continue;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (this.#host.walkable(cell.c + dc, cell.r + dr)) banks.push({ bank: { c: cell.c + dc, r: cell.r + dr }, water: cell });
      }
    }
    if (!banks.length) return false;
    const { bank, water } = pickOne(banks);
    this.#walk(pet, bank, () => {
      const id = pet.walkId;
      const into = this.#host.tileXY(water.c, water.r);
      const back = { ...pet.pos };
      pet.facing = into.x < pet.pos.x ? -1 : 1;
      pet.later.push(this.#host.scene.tweens.add({
        targets: pet.pos, x: into.x, y: into.y + this.#host.waterDrop, duration: 900, ease: 'Sine.easeInOut',
        onComplete: () => {
          pet.pose = 'swim';
          this.#later(pet, rand(10_000, 20_000), () => {
            if (pet.walkId !== id) return;
            pet.pose = 'sit';
            pet.facing = back.x < pet.pos.x ? -1 : 1;
            pet.later.push(this.#host.scene.tweens.add({ targets: pet.pos, x: back.x, y: back.y, duration: 900, ease: 'Sine.easeInOut', onComplete: () => this.#rest(pet, 'sit', rand(3000, 6000)) }));
          });
        },
      }));
    });
    return true;
  }

  /** Walks a tile at a time to a tile, at its own pace. */
  #walk(pet: Pet, target: Spot, done: () => void): void {
    const id = ++pet.walkId;
    const path = findPath(this.#host.walkable, pet.cell, target);
    pet.pose = 'sit';
    const step = () => {
      if (pet.walkId !== id) return;
      const next = path.shift();
      if (!next) {
        pet.moving = false;
        return done();
      }
      const to = this.#host.spotXY(next);
      const A = this.#host.art.scale;
      const dist = Math.hypot(to.x - pet.pos.x, to.y - pet.pos.y);
      pet.moving = true;
      if (Math.abs(to.x - pet.pos.x) > A) pet.facing = to.x < pet.pos.x ? -1 : 1;
      pet.later.push(this.#host.scene.tweens.add({ targets: pet.pos, x: to.x, y: to.y, duration: Math.max(140, (dist / A) * 26) * ROAM[pet.kind].pace, onComplete: () => { pet.cell = next; step(); } }));
    };
    step();
  }

  /** A tile it can stand on within its reach of home. */
  #somewhere(pet: Pet): Spot {
    const reach = ROAM[pet.kind].reach;
    const open: Spot[] = [];
    for (let c = pet.home.c - reach; c <= pet.home.c + reach; c++) for (let r = pet.home.r - reach; r <= pet.home.r + reach; r++) if (this.#host.walkable(c, r)) open.push({ c, r });
    return open.length ? pickOne(open) : pet.home;
  }

  /** A mirling on the move within the dog's reach of home, to trot after. */
  #movingMirlingNear(pet: Pet): Spot | null {
    const reach = ROAM.dog.reach + 1;
    const near = this.#host.mirlings().filter((m) => m.moving && Math.max(Math.abs(m.cell.c - pet.home.c), Math.abs(m.cell.r - pet.home.r)) <= reach);
    return near.length ? pickOne(near).cell : null;
  }

  #later(pet: Pet, ms: number, then: () => void): void {
    pet.later.push(this.#host.scene.time.delayedCall(ms, then));
  }

  /** Stops whatever it was doing, and takes it off the island unless it's staying. */
  #forget(pet: Pet, gone = true): void {
    for (const thing of pet.later) thing.remove();
    pet.later = [];
    pet.walkId += 1;
    this.#host.scene.tweens.killTweensOf(pet.pos);
    if (gone) pet.sprite.destroy();
  }
}
