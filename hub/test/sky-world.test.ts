import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findPath, generateCells, SEC, sectionOrigin, slot, spotsAround, templateBuildings, type Cell } from '../web/sky/world.ts';

describe('the island layout', () => {
  it('places sections on a growing square without moving the ones already there', () => {
    assert.deepEqual(Array.from({ length: 9 }, (_, i) => slot(i)), [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
    const seen = new Set(Array.from({ length: 30 }, (_, i) => slot(i).join(',')));
    assert.equal(seen.size, 30);
  });

  it('keeps every existing section exactly as it was when a project is added', () => {
    const three = generateCells(['code', 'code', 'code']);
    const four = generateCells(['code', 'code', 'code', 'code']);
    for (const cell of three.values()) {
      if (cell.section === null) continue;
      assert.deepEqual(four.get(`${cell.c},${cell.r}`), cell);
    }
    assert.ok(four.size > three.size);
  });

  it('rings each section with a hedge, with a gate in the middle of every side', () => {
    const cells = generateCells(['code']);
    const { c0, r0 } = sectionOrigin(0);
    const at = (lc: number, lr: number) => cells.get(`${c0 + lc},${r0 + lr}`) as Cell;
    assert.equal(at(0, 0).ch, 'h');
    assert.equal(at(4, 0).ch, 'p');
    assert.equal(at(0, 5).ch, 'p');
    assert.equal(at(SEC - 1, 2).ch, 'h');
    assert.equal(at(2, 3).section, 0);
    assert.equal(generateCells([]).size, 0);
  });

  it('puts the template buildings inside the section, each with somewhere to stand', () => {
    const cells = generateCells(['code']);
    const walkable = (c: number, r: number) => cells.get(`${c},${r}`)?.walk ?? false;
    const buildings = templateBuildings(0, 'code');
    assert.deepEqual([...new Set(buildings.map((b) => b.type))].sort(), ['house', 'library', 'workshop']);
    assert.equal(buildings.filter((b) => b.type === 'house').length, 5);
    for (const b of buildings) assert.ok(spotsAround(b, walkable).length > 0, `${b.type} at ${b.c},${b.r} has nowhere to stand`);
  });

  it('finds walks around obstacles without cutting corners, and none through walls', () => {
    const open = new Set(['0,0', '1,0', '2,0', '2,1', '2,2', '1,1']);
    const walkable = (c: number, r: number) => open.has(`${c},${r}`);
    const path = findPath(walkable, { c: 0, r: 0 }, { c: 2, r: 2 });
    assert.deepEqual(path.at(-1), { c: 2, r: 2 });
    for (const step of path) assert.ok(walkable(step.c, step.r));
    assert.deepEqual(findPath(walkable, { c: 0, r: 0 }, { c: 5, r: 5 }), []);
  });
});
