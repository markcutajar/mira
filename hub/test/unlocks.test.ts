import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Store } from '../src/store.ts';
import { unlocksFrom } from '../src/unlocks.ts';

describe('landmarks earned with time and work (decision 68)', () => {
  it('unlocks nothing before the first turn', () => {
    const none = unlocksFrom({ first: null, turns: 0, nthAt: () => null }, new Date('2026-10-31T12:00:00Z'));
    assert.deepEqual(Object.values(none).map((p) => p.at), [null, null, null, null, null]);
    assert.deepEqual(none.windmill, { at: null, have: 0, need: 7 });
  });

  it('counts days since the first turn, and turns, from the token counts the store keeps for good', () => {
    const store = new Store(':memory:');
    const turn = (n: number, at: string): MiraEvent => ({
      v: 1, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, at, source: 'claude-code', system: 'mira',
      actor: { kind: 'session', id: 's-1' }, type: 'usage.reported', usage: { inputTokens: 1, outputTokens: 1 },
    });
    for (let n = 1; n <= 120; n++) store.add(turn(n, new Date(Date.UTC(2026, 9, 1) + n * 3_600_000).toISOString()));
    const at = unlocksFrom(store.turnTally(), new Date('2026-10-12T00:00:00Z'));
    assert.deepEqual(at.windmill, { at: '2026-10-08T01:00:00.000Z', have: 7, need: 7 });
    assert.deepEqual(at.fountain, { at: '2026-10-05T04:00:00.000Z', have: 100, need: 100 });
    assert.deepEqual(at.observatory, { at: null, have: 10, need: 30 });
    assert.deepEqual(at.lighthouse, { at: null, have: 120, need: 1000 });
    store.close();
  });
});
