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

  it("lists the folders a system's events named, most recent first", () => {
    const store = new Store(':memory:');
    const add = (n: number, cwd: string, second: number, type: MiraEvent['type'] = 'tool.started') =>
      store.add({ ...event(`00000000-0000-4000-8000-00000000020${n}`, `2026-10-25T18:00:0${second}.000Z`), type, detail: { cwd } });
    add(1, 'C:\\code\\mira', 1);
    add(2, 'C:\\code\\mira\\.claude\\worktrees\\x', 2);
    add(3, 'C:\\code\\mira', 3);
    add(4, 'C:\\Users\\me\\.claude\\projects', 4, 'session.moved');
    assert.deepEqual(store.folders('mira'), ['C:\\code\\mira', 'C:\\code\\mira\\.claude\\worktrees\\x']);
    assert.deepEqual(store.folders('garden'), []);
    store.close();
  });

  it('keeps my names and removals, and forgets a name set to empty', () => {
    const store = new Store(':memory:');
    store.setName('system', 'acme-core', 'Acme');
    store.setName('system', 'acme-core', 'Acme core');
    store.setName('session', 's-1', 'Auth refactor');
    store.setName('session', 's-1', '');
    store.remove('session', 's-2', '2026-10-25T18:00:00.000Z');
    assert.deepEqual(store.names('system'), { 'acme-core': 'Acme core' });
    assert.deepEqual(store.names('session'), {});
    assert.deepEqual(store.removed('session'), { 's-2': '2026-10-25T18:00:00.000Z' });
    assert.deepEqual(store.removed('system'), {});
    store.close();
  });

  it('lists systems active since a time, in the order each first appeared', () => {
    const store = new Store(':memory:');
    const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T12:00:00.000Z`;
    const add = (n: number, system: string, day: number) => store.add({ ...event(`00000000-0000-4000-8000-00000000010${n}`, at(day)), system });
    add(1, 'garden', 10);
    add(2, 'mira', 12);
    add(3, 'old', 1);
    add(4, 'garden', 20);
    store.add({ ...event('00000000-0000-4000-8000-000000000105', at(15)), system: 'projects', type: 'session.moved', status: undefined });
    assert.deepEqual(store.systems(at(5)).map((s) => [s.name, s.firstAt, s.lastAt]), [['garden', at(10), at(20)], ['mira', at(12), at(12)]]);
    store.close();
  });
});

describe('placeFor', () => {
  // `root` is the project's own folder: where a new session for it starts.
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
    assert.deepEqual(placeFor(resolve('/code/mira/hub/src')), { system: 'mira', root: resolve('/code/mira') });
  });

  it('puts a worktree in its main repo section, labelled with its own folder', () => {
    assert.deepEqual(placeFor(resolve('/code/mira/.claude/worktrees/feature-x/hub')), { system: 'mira', worktree: 'feature-x', root: resolve('/code/mira') });
    assert.deepEqual(placeFor(resolve('/code/mira/.claude/worktrees/hotfix')), { system: 'mira', worktree: 'hotfix', root: resolve('/code/mira') });
  });

  it('keeps a submodule as a section of its own', () => {
    assert.deepEqual(placeFor(resolve('/code/app/vendor/lib')), { system: 'lib', root: resolve('/code/app/vendor/lib') });
  });

  it('renames or groups sections from the config, worktrees included', () => {
    const renamed = makePlaceResolver({ mira: 'Mira' }, gitMarker);
    assert.deepEqual(renamed(resolve('/code/mira')), { system: 'Mira', root: resolve('/code/mira') });
    assert.deepEqual(renamed(resolve('/code/mira/.claude/worktrees/feature-x')), { system: 'Mira', worktree: 'feature-x', root: resolve('/code/mira') });
  });

  it('uses the working folder outside a repo', () => {
    assert.deepEqual(placeFor(resolve('/scratch/notes')), { system: 'notes', root: resolve('/scratch/notes') });
    assert.deepEqual(placeFor(undefined), { system: 'unknown' });
  });

  describe('on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-places-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('reads a real worktree link', () => {
      mkdirSync(join(dir, 'garden', '.git', 'worktrees', 'search'), { recursive: true });
      mkdirSync(join(dir, 'garden-search', 'src'), { recursive: true });
      writeFileSync(join(dir, 'garden-search', '.git'), `gitdir: ${join(dir, 'garden', '.git', 'worktrees', 'search')}\n`);
      assert.deepEqual(makePlaceResolver({})(join(dir, 'garden-search', 'src')), { system: 'garden', worktree: 'garden-search', root: join(dir, 'garden') });
      assert.deepEqual(makePlaceResolver({})(join(dir, 'garden')), { system: 'garden', root: join(dir, 'garden') });
    });
  });
});
