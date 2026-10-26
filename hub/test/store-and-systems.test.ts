import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Store } from '../src/store.ts';
import { makePlaceResolver, type GitMarker } from '../src/systems.ts';

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

describe('placeFor', () => {
  const markers = new Map<string, GitMarker>([
    [resolve('/code/mira'), { kind: 'repo' }],
    [resolve('/code/mira/.claude/worktrees/feature-x'), { kind: 'link', gitdir: resolve('/code/mira/.git/worktrees/feature-x') }],
    [resolve('/code/mira/.claude/worktrees/hotfix'), { kind: 'link', gitdir: '../../../.git/worktrees/hotfix' }],
    [resolve('/code/app'), { kind: 'repo' }],
    [resolve('/code/app/vendor/lib'), { kind: 'link', gitdir: '../../.git/modules/lib' }],
  ]);
  const gitMarker = (dir: string) => markers.get(dir) ?? null;
  const placeFor = makePlaceResolver({}, gitMarker);

  it('names the section after the repo folder', () => {
    assert.deepEqual(placeFor(resolve('/code/mira/hub/src')), { system: 'mira' });
  });

  it('puts a worktree in its main repo section, labelled with its own folder', () => {
    assert.deepEqual(placeFor(resolve('/code/mira/.claude/worktrees/feature-x/hub')), { system: 'mira', worktree: 'feature-x' });
    assert.deepEqual(placeFor(resolve('/code/mira/.claude/worktrees/hotfix')), { system: 'mira', worktree: 'hotfix' });
  });

  it('keeps a submodule as a section of its own', () => {
    assert.deepEqual(placeFor(resolve('/code/app/vendor/lib')), { system: 'lib' });
  });

  it('renames or groups sections from the config, worktrees included', () => {
    const renamed = makePlaceResolver({ mira: 'Mira' }, gitMarker);
    assert.deepEqual(renamed(resolve('/code/mira')), { system: 'Mira' });
    assert.deepEqual(renamed(resolve('/code/mira/.claude/worktrees/feature-x')), { system: 'Mira', worktree: 'feature-x' });
  });

  it('uses the working folder outside a repo', () => {
    assert.deepEqual(placeFor(resolve('/scratch/notes')), { system: 'notes' });
    assert.deepEqual(placeFor(undefined), { system: 'unknown' });
  });

  describe('on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-places-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('reads a real worktree link', () => {
      mkdirSync(join(dir, 'garden', '.git', 'worktrees', 'search'), { recursive: true });
      mkdirSync(join(dir, 'garden-search', 'src'), { recursive: true });
      writeFileSync(join(dir, 'garden-search', '.git'), `gitdir: ${join(dir, 'garden', '.git', 'worktrees', 'search')}\n`);
      assert.deepEqual(makePlaceResolver({})(join(dir, 'garden-search', 'src')), { system: 'garden', worktree: 'garden-search' });
      assert.deepEqual(makePlaceResolver({})(join(dir, 'garden')), { system: 'garden' });
    });
  });
});
