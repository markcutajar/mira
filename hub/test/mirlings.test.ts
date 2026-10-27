import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MirlingNames, PACKS, SEATS } from '../src/mirlings.ts';
import { Store } from '../src/store.ts';

describe('mirling names', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('gives every mirling in view a name of its own', () => {
    const named = new MirlingNames(new Store(':memory:')).names(ids);
    assert.equal(named.size, ids.length);
    assert.equal(new Set(named.values()).size, ids.length);
    for (const name of named.values()) assert.ok((PACKS.cute as readonly string[]).includes(name));
  });

  it('keeps a name for the life of its session, across restarts, and the pack only changes how it reads', () => {
    const store = new Store(':memory:');
    const first = new MirlingNames(store).names(ids.slice(0, 5));
    assert.deepEqual(new MirlingNames(store).names(ids.slice(0, 5).reverse()), new Map([...first].reverse()));
    assert.deepEqual(new MirlingNames(store).names(ids.slice(2, 3)).get(ids[2] as string), first.get(ids[2] as string));
    const stars = new MirlingNames(store, 'stars').names(ids.slice(0, 5));
    assert.deepEqual([...stars.keys()], [...first.keys()]);
    for (const [id, name] of stars) assert.equal(PACKS.stars.indexOf(name as never), PACKS.cute.indexOf(first.get(id) as never));
  });

  it('moves a mirling whose seat another already holds, and forgets seats as old events go', () => {
    const store = new Store(':memory:');
    store.setSeat('a', 7, '2026-10-01T00:00:00.000Z');
    store.setSeat('b', 7, '2026-10-01T00:00:00.000Z'); // say, an earlier conversation picked up again
    const named = new MirlingNames(store).names(['a', 'b']);
    assert.equal(named.get('a'), PACKS.cute[7]);
    assert.notEqual(named.get('b'), PACKS.cute[7]);
    store.prune('2026-10-02T00:00:00.000Z');
    assert.deepEqual(Object.keys(store.seats()), ['b']); // seated again just now, so kept
  });

  it('has a name for every seat in every pack, with no name twice', () => {
    for (const pack of Object.values(PACKS)) {
      assert.ok(pack.length >= SEATS);
      assert.equal(new Set(pack).size, pack.length);
    }
  });
});
