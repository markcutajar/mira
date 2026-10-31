import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { arrange, destinations, edit, move, movePiece, pieceAt, placeOf, restyle, sameLayouts, unreachable } from '../web/sky/build.ts';
import { findPath, generateCells, SEC, sectionOrigin, slot, spotsAround, templateBuildings, type Cell } from '../web/sky/world.ts';

describe('the island layout', () => {
  it('places sections on a growing square without moving the ones already there', () => {
    assert.deepEqual(Array.from({ length: 9 }, (_, i) => slot(i)), [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1], [0, 2], [1, 2], [2, 2]]);
    const seen = new Set(Array.from({ length: 30 }, (_, i) => slot(i).join(',')));
    assert.equal(seen.size, 30);
  });

  it("keeps every section's own ground exactly as it was when a project is added", () => {
    const three = generateCells(['code', 'code', 'code']);
    const four = generateCells(['code', 'code', 'code', 'code']);
    for (const cell of three.values()) {
      if (cell.section === null) continue;
      const { c0, r0 } = sectionOrigin(cell.section);
      const inside = [cell.c - c0, cell.r - r0].every((v) => v > 0 && v < SEC - 1);
      if (inside) assert.deepEqual(four.get(`${cell.c},${cell.r}`), cell);
    }
    assert.ok(four.size > three.size);
  });

  it('gives a lone section an open shore with a gate in the middle of every side, and no stream', () => {
    const cells = generateCells(['code']);
    const { c0, r0 } = sectionOrigin(0);
    const at = (lc: number, lr: number) => cells.get(`${c0 + lc},${r0 + lr}`) as Cell;
    assert.ok([at(0, 0), at(SEC - 1, 2), at(3, SEC - 1)].every((cell) => cell.walk && cell.section === 0));
    assert.deepEqual([at(4, 0).ch, at(0, 5).ch], ['p', 'p']);
    assert.equal([...cells.values()].some((cell) => cell.section === null && (cell.ch === 'w' || cell.ch === 'b')), false);
    assert.equal(generateCells([]).size, 0);
  });

  it('runs a stream between neighbouring sections out to the coast, with a bridge where their gates meet', () => {
    const cells = generateCells(['code', 'code']);
    const { c0, r0 } = sectionOrigin(0);
    const at = (c: number, r: number) => cells.get(`${c},${r}`) as Cell;
    const stream = [...cells.values()].filter((cell) => cell.c === c0 + SEC || cell.c === c0 + SEC + 1);
    assert.ok(stream.every((cell) => cell.ch === 'w' || cell.ch === 'b'));
    assert.ok(Math.min(...stream.map((cell) => cell.r)) < r0 - 1 && Math.max(...stream.map((cell) => cell.r)) > r0 + SEC); // past both sections
    assert.deepEqual(stream.filter((cell) => cell.ch === 'b').map((cell) => [cell.c - c0, cell.r - r0, cell.span, cell.walk]), [[SEC, 4, 'c', true], [SEC + 1, 4, 'c', true], [SEC, 5, 'c', true], [SEC + 1, 5, 'c', true]]);
    const walkable = (c: number, r: number) => cells.get(`${c},${r}`)?.walk ?? false;
    assert.ok(findPath(walkable, at(c0 + SEC - 1, r0 + 4), at(sectionOrigin(1).c0, r0 + 4)).length > 0); // across the bridge
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

  it('puts up fences, hedges and flowering bushes, which mirlings walk round (decision 66)', () => {
    const cells = generateCells(['code']);
    const free = [...cells.values()].filter((cell) => cell.section === 0 && cell.walk && cell.ch === 'g' && cell.c > c0 && cell.r > r0 && cell.c < c0 + SEC - 1 && cell.r < r0 + SEC - 1).slice(0, 3);
    const kinds = ['fence', 'hedge', 'flower-bush'];
    arrange(cells, 0, 'code', { placed: Object.fromEntries(free.map((cell, i) => [`${cell.c - c0},${cell.r - r0}`, kinds[i] as string])) });
    assert.deepEqual(free.map((cell) => [cell.item, cell.walk]), kinds.map((kind) => [kind, false]));
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
    assert.deepEqual(move(undefined, 2, at(cells, 3, 1), { i: 0, place: '3,1', own: true }), { layout: { moved: { 2: [3, 1] } } });
    assert.ok('refused' in move(undefined, 2, at(cells, 0, 1), { i: 0, place: '0,1', own: false })); // the shore
    assert.deepEqual(restyle(undefined, 0, 'stone'), { layout: { styles: { 0: 'brick' } } });
  });

  it('builds on the shore and coast, puts boats and lily pads only on water, and leaves bridges be', () => {
    const cells = generateCells(['code', 'code']);
    const shore = at(cells, 0, 1);
    const coast = [...cells.values()].find((c) => c.section === null && c.ch === 'g' && c.c === c0 - 2) as Cell;
    const out = `-2,${coast.r - r0}`;
    const stream = at(cells, 10, 1);
    const bridge = at(cells, 10, 4);
    assert.deepEqual([stream.ch, bridge.ch], ['w', 'b']);
    assert.deepEqual(edit(undefined, 'rock', shore, '0,1'), { layout: { placed: { '0,1': 'rock' } } });
    assert.deepEqual(edit(undefined, 'flowers', coast, out), { layout: { ground: { [out]: 'f' } } });
    assert.deepEqual(edit(undefined, 'boat', stream, '10,1'), { layout: { placed: { '10,1': 'boat' } } });
    assert.ok('refused' in edit(undefined, 'boat', shore, '0,1'));
    assert.ok('refused' in edit(undefined, 'rock', stream, '10,1'));
    assert.ok('refused' in edit(undefined, 'path', stream, '10,1'));
    assert.ok('refused' in edit(undefined, 'lilies', bridge, '10,4'));
    assert.ok('refused' in edit(undefined, 'grass', bridge, '10,4'));
    arrange(cells, 0, 'code', { placed: { '0,1': 'rock', '10,1': 'boat', '10,4': 'lamp', '0,2': 'boat' }, ground: { [out]: 'f', '10,5': 'p' } });
    assert.deepEqual([shore.item, shore.walk, shore.by], ['rock', false, 0]);
    assert.deepEqual([stream.item, coast.ch], ['boat', 'f']);
    assert.deepEqual([bridge.item, bridge.ch, at(cells, 10, 5).ch], [undefined, 'b', 'b']); // a bridge takes neither
    assert.equal(at(cells, 0, 2).item, undefined); // a boat on land
  });

  it('finds whose layout a tile is in: its own ground, or the nearest section within reach of its shore', () => {
    const one = sectionOrigin(1);
    assert.deepEqual(placeOf(c0 + 1, r0 + 8, 1), { i: 0, place: '1,8', own: true });
    assert.deepEqual(placeOf(c0, r0 + 3, 1), { i: 0, place: '0,3', own: false });
    assert.deepEqual(placeOf(c0 - 3, r0 + 12, 1), { i: 0, place: '-3,12', own: false });
    assert.equal(placeOf(c0 - 4, r0 + 3, 1), null);
    assert.deepEqual(placeOf(one.c0 + 4, one.r0 + 4, 2), { i: 1, place: '4,4', own: true });
    // The stream between two sections: its near bank's half to each.
    assert.deepEqual(placeOf(c0 + 10, r0 + 2, 2), { i: 0, place: '10,2', own: false });
    assert.deepEqual(placeOf(c0 + 11, r0 + 2, 2), { i: 1, place: '-1,2', own: false });
    // A tile a layout already changed stays in that layout.
    assert.deepEqual(placeOf(c0 + 11, r0 + 2, 2, 0), { i: 0, place: '11,2', own: false });
  });

  it('puts up, moves and takes away play pieces, the template\'s own included', () => {
    const cells = generateCells(['code']);
    assert.deepEqual([at(cells, 8, 4).ch, at(cells, 8, 6).ch], ['S', 'D']); // the template's swings and slide
    assert.deepEqual(edit(undefined, 'trampoline', at(cells, 1, 1), '1,1'), { layout: { placed: { '1,1': 'trampoline' } } });
    assert.ok('refused' in edit(undefined, 'slide', at(cells, 3, 5), '3,5', true)); // the pond
    assert.deepEqual(edit(undefined, 'remove', at(cells, 8, 4), '8,4'), { layout: { removed: ['8,4'] } });
    const moved = movePiece(undefined, 'slide', '8,6', at(cells, 1, 2), '1,2');
    assert.deepEqual(moved, { layout: { removed: ['8,6'], placed: { '1,2': 'slide' } } });
    assert.ok('refused' in movePiece(undefined, 'slide', '8,6', at(cells, 2, 3), '2,3')); // the library stands there
    const layout = { removed: ['8,6'], placed: { '1,2': 'slide', '1,1': 'trampoline' } };
    arrange(cells, 0, 'code', layout);
    assert.deepEqual([at(cells, 8, 6).ch, at(cells, 8, 6).walk, at(cells, 1, 2).ch, at(cells, 1, 1).ch, at(cells, 1, 1).walk], ['g', true, 'D', 'J', false]);
    assert.deepEqual([pieceAt(at(cells, 1, 1)), pieceAt(at(cells, 8, 4)), pieceAt(at(cells, 2, 2))], ['trampoline', 'swings', undefined]);
    // One I put up moves off its own place rather than being listed as taken away.
    assert.deepEqual(movePiece(layout, 'trampoline', '1,1', at(cells, 3, 1), '3,1'), { layout: { removed: ['8,6'], placed: { '1,2': 'slide', '3,1': 'trampoline' } } });
  });

  it('digs ponds and fills them in, but never a stream', () => {
    const cells = generateCells(['code', 'code']);
    const coast = [...cells.values()].find((c) => c.section === null && c.ch === 'g' && c.c === c0 - 2) as Cell;
    const out = `-2,${coast.r - r0}`;
    assert.deepEqual(edit(undefined, 'water', at(cells, 1, 1), '1,1', true), { layout: { ground: { '1,1': 'w' } } });
    assert.deepEqual(edit(undefined, 'grass', at(cells, 3, 5), '3,5', true), { layout: { ground: { '3,5': 'g' } } }); // the template's pond
    assert.ok('refused' in edit(undefined, 'water', at(cells, 3, 5), '3,5', true)); // water already
    assert.ok('refused' in edit(undefined, 'grass', at(cells, 10, 1), '10,1')); // a stream
    arrange(cells, 0, 'code', { ground: { '1,1': 'w', '3,5': 'g', [out]: 'w', '10,1': 'g' } });
    assert.deepEqual([at(cells, 1, 1).ch, at(cells, 1, 1).walk, at(cells, 3, 5).ch, at(cells, 3, 5).walk, coast.ch], ['w', false, 'g', true, 'w']);
    assert.equal(at(cells, 10, 1).ch, 'w'); // a stream stays, whatever a layout says
    // Water I dug on the coast can be filled in again.
    assert.deepEqual(edit({ ground: { [out]: 'w' } }, 'flowers', coast, out), { layout: { ground: { [out]: 'f' } } });
  });

  it('notices a building or play piece left with no way in', () => {
    const cells = generateCells(['code']);
    const everything = () => destinations(cells, [arrange(cells, 0, 'code')]);
    assert.deepEqual(unreachable(cells, everything()), []);
    // Water all round the library, which stands at 2,3.
    const ring = ['1,2', '2,2', '3,2', '1,3', '3,3', '1,4', '2,4', '3,4'];
    const walled = generateCells(['code']);
    const placed = arrange(walled, 0, 'code', { ground: Object.fromEntries(ring.map((p) => [p, 'w' as const])) });
    assert.deepEqual(unreachable(walled, destinations(walled, [placed])).map((d) => d.label), ['library']);
    // A play piece counts too: a trampoline in the corner, with water on the shore and ground around it.
    const corner = generateCells(['code']);
    const round = ['0,0', '1,0', '2,0', '0,1', '0,2', '1,2', '2,2'];
    const pieces = arrange(corner, 0, 'code', { placed: { '1,1': 'trampoline' }, ground: Object.fromEntries(round.map((p) => [p, 'w' as const])) });
    assert.ok(unreachable(corner, destinations(corner, [pieces])).some((d) => d.label === 'trampoline'));
  });

  it('treats layouts as the same whatever order their keys came in', () => {
    assert.ok(sameLayouts({ mira: { placed: { '1,1': 'lamp' }, ground: { '2,2': 'p' } } }, { mira: { ground: { '2,2': 'p' }, placed: { '1,1': 'lamp' } } }));
    assert.ok(!sameLayouts({ mira: { placed: { '1,1': 'lamp' } } }, {}));
  });
});
