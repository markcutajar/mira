import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { arrange, edit, move, placeOf, restyle, sameLayouts } from '../web/sky/build.ts';
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

describe('build mode', () => {
  const { c0, r0 } = sectionOrigin(0);
  const at = (cells: Map<string, Cell>, lc: number, lr: number) => cells.get(`${c0 + lc},${r0 + lr}`) as Cell;

  it('places plants and decorations, paints ground and takes trees away, only on free tiles', () => {
    const cells = generateCells(['code']);
    arrange(cells, 0, 'code', { placed: { '1,1': 'bench', '2,1': 'lamp', '3,1': 'castle' }, ground: { '4,1': 'g', '1,2': 'p' }, removed: ['8,1'] });
    assert.deepEqual([at(cells, 1, 1).item, at(cells, 1, 1).walk], ['bench', false]);
    assert.equal(at(cells, 2, 1).item, undefined); // a house stands there
    assert.equal(at(cells, 3, 1).item, undefined); // no such thing
    assert.deepEqual([at(cells, 4, 1).ch, at(cells, 1, 2).ch], ['g', 'p']);
    assert.deepEqual([at(cells, 8, 1).ch, at(cells, 8, 1).walk], ['g', true]);
  });

  it('moves buildings to free tiles, lets two swap places, and keeps a house its style', () => {
    const plain = arrange(generateCells(['code']), 0, 'code');
    const cells = generateCells(['code']);
    // Index 0 is the house at 2,1 and index 2 the library at 2,3.
    const placed = arrange(cells, 0, 'code', { moved: { 0: [2, 3], 2: [2, 1], 1: [2, 3] }, styles: { 3: 'stone' } });
    assert.deepEqual([placed[0]?.c, placed[0]?.r], [c0 + 2, r0 + 3]);
    assert.deepEqual([placed[2]?.c, placed[2]?.r], [c0 + 2, r0 + 1]);
    assert.deepEqual([placed[1]?.c, placed[1]?.r], [plain[1]?.c, plain[1]?.r]); // its new place was taken, so it stayed
    assert.deepEqual([at(cells, 2, 3).ch, at(cells, 2, 1).ch], ['H', 'L']);
    assert.equal(placed[0]?.style, plain[0]?.style);
    assert.equal(placed[3]?.style, 'stone');
  });

  it('says what a tool does to a tile, or why it cannot', () => {
    const cells = generateCells(['code']);
    const free = at(cells, 1, 1);
    const placed = edit(undefined, 'lamp', free, '1,1');
    assert.deepEqual(placed, { layout: { placed: { '1,1': 'lamp' } } });
    arrange(cells, 0, 'code', 'layout' in placed ? placed.layout : undefined);
    assert.ok('refused' in edit(undefined, 'bench', at(cells, 1, 1), '1,1'));
    assert.deepEqual(edit({ placed: { '1,1': 'lamp' } }, 'remove', at(cells, 1, 1), '1,1'), { layout: { placed: {} } });
    assert.deepEqual(edit(undefined, 'remove', at(cells, 8, 1), '8,1'), { layout: { removed: ['8,1'] } });
    assert.ok('refused' in edit(undefined, 'remove', at(cells, 3, 1), '3,1'));
    assert.ok('refused' in edit(undefined, 'path', at(cells, 4, 1), '4,1')); // a path already
    assert.deepEqual(move(undefined, 2, at(cells, 3, 1), '3,1'), { layout: { moved: { 2: [3, 1] } } });
    assert.deepEqual(restyle(undefined, 0, 'stone'), { layout: { styles: { 0: 'brick' } } });
  });

  it('finds the section and place inside its hedge, and nothing on the hedge or outside', () => {
    assert.deepEqual(placeOf(c0 + 1, r0 + 8, 1), { i: 0, place: '1,8' });
    assert.equal(placeOf(c0, r0 + 3, 1), null);
    assert.equal(placeOf(c0 + 9, r0 + 3, 1), null);
    assert.deepEqual(placeOf(sectionOrigin(1).c0 + 4, sectionOrigin(1).r0 + 4, 2), { i: 1, place: '4,4' });
  });

  it('treats layouts as the same whatever order their keys came in', () => {
    assert.ok(sameLayouts({ mira: { placed: { '1,1': 'lamp' }, ground: { '2,2': 'p' } } }, { mira: { ground: { '2,2': 'p' }, placed: { '1,1': 'lamp' } } }));
    assert.ok(!sameLayouts({ mira: { placed: { '1,1': 'lamp' } } }, {}));
  });
});
