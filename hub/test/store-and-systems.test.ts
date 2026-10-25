import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Store } from '../src/store.ts';
import { makeSystemResolver } from '../src/systems.ts';

const event = (id: string, at: string): MiraEvent => ({
  v: 1, id, at, source: 'claude-code', system: 'mira', actor: { kind: 'session', id: 's-1' }, type: 'tool.started', status: 'working',
});

describe('Store', () => {
  it('stores events once and reads them back in order', () => {
    const store = new Store(':memory:');
    const a = event('00000000-0000-4000-8000-000000000001', '2026-10-25T18:00:01.000Z');
    const b = event('00000000-0000-4000-8000-000000000002', '2026-10-25T18:00:02.000Z');
    assert.equal(store.add(a), true);
    assert.equal(store.add(b), true);
    assert.equal(store.add(a), false);
    assert.deepEqual(store.recent(10).map((e) => e.id), [b.id, a.id]);
    assert.deepEqual(store.since('2026-10-25T18:00:02.000Z').map((e) => e.id), [b.id]);
    store.close();
  });
});

describe('systemFor', () => {
  const repo = resolve('/code/acme-core');
  const isRepoRoot = (dir: string) => dir === repo;

  it('names the section after the repo folder', () => {
    assert.equal(makeSystemResolver({}, isRepoRoot)(resolve(repo, 'src', 'auth')), 'acme-core');
  });

  it('renames or groups sections from the config', () => {
    assert.equal(makeSystemResolver({ 'acme-core': 'Acme' }, isRepoRoot)(repo), 'Acme');
  });

  it('uses the working folder outside a repo', () => {
    assert.equal(makeSystemResolver({}, isRepoRoot)(resolve('/scratch/notes')), 'notes');
    assert.equal(makeSystemResolver({}, isRepoRoot)(undefined), 'unknown');
  });
});
