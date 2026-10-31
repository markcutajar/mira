import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Store } from '../src/store.ts';
import { makePlaceResolver, makeSectionNamer, type GitMarker } from '../src/systems.ts';

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

  it('counts each project\'s trips for the paths its mirlings wear, groups included (decision 67)', () => {
    const store = new Store(':memory:', (stored) => (stored.startsWith('acme-') ? 'Acme' : stored));
    let n = 0;
    const add = (system: string, type: MiraEvent['type'], tool?: string, at = '2026-10-25T18:00:00.000Z') =>
      store.add({ ...event(`00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, at), system, type, ...(tool ? { detail: { tool } } : {}) });
    for (const tool of ['Read', 'Grep', 'Edit', 'Bash', 'Agent']) add('mira', 'tool.started', tool);
    add('mira', 'turn.ended');
    add('mira', 'tool.started', 'Read', '2026-09-01T00:00:00.000Z'); // too long ago
    add('acme-web', 'tool.started', 'Write');
    add('acme-api', 'tool.started', 'Write');
    assert.deepEqual(store.trips('2026-10-01T00:00:00.000Z'), { mira: { read: 2, make: 1, run: 1, turns: 1 }, Acme: { read: 0, make: 2, run: 0, turns: 0 } });
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

  it('prunes old events but keeps the token counts that are the cost history', () => {
    const store = new Store(':memory:');
    store.add(event('00000000-0000-4000-8000-000000000301', '2026-06-01T12:00:00.000Z'));
    store.add({ ...event('00000000-0000-4000-8000-000000000302', '2026-06-01T12:00:00.000Z'), type: 'usage.reported', status: undefined, usage: { outputTokens: 5 } });
    store.add(event('00000000-0000-4000-8000-000000000303', '2026-10-25T12:00:00.000Z'));
    assert.equal(store.prune('2026-07-27T00:00:00.000Z'), 1);
    assert.deepEqual(store.since('2026-01-01T00:00:00.000Z').map((e) => e.id.slice(-3)), ['302', '303']);
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

  it('brings the history of repos grouped in the config into their group', () => {
    const store = new Store(':memory:', makeSectionNamer({ 'site-*': 'Site' }).name);
    const at = (n: number) => `2026-10-${String(n).padStart(2, '0')}T12:00:00.000Z`;
    const add = (n: number, system: string, day: number, more: Partial<MiraEvent> = {}) =>
      store.add({ ...event(`00000000-0000-4000-8000-00000000040${n}`, at(day)), system, detail: { cwd: `C:\\code\\${system}` }, ...more });
    add(1, 'mira', 9);
    add(2, 'site-docs', 11);
    add(3, 'site-app', 10); // stored before the group existed
    add(4, 'Site', 20, { detail: { cwd: 'C:\\code\\site-api' } }); // stored under the group
    add(5, 'site-app', 12, { type: 'usage.reported', status: undefined, usage: { outputTokens: 7, costUsd: 0.25 } });
    assert.deepEqual(store.systems(at(5)).map((s) => [s.name, s.firstAt, s.lastAt]), [['mira', at(9), at(9)], ['Site', at(10), at(20)]]);
    assert.deepEqual(store.since(at(1)).map((e) => e.system), ['mira', 'Site', 'Site', 'Site', 'Site']);
    assert.deepEqual(store.folders('Site'), ['C:\\code\\site-api', 'C:\\code\\site-app', 'C:\\code\\site-docs']);
    assert.deepEqual(store.spent('Site'), { 's-1': { tokens: 7, costUsd: 0.25 } });
    assert.deepEqual(store.spent('site-app'), {});
    store.close();
  });

  it("starts a group from the repo I arranged most, until I arrange the group itself", () => {
    const store = new Store(':memory:', makeSectionNamer({ 'site-*': 'Site' }).name);
    store.setLayout('site-app', { placed: { '1,1': 'bench' } });
    store.setLayout('site-docs', { placed: { '1,1': 'bench', '2,2': 'lamp' } });
    store.setLayout('mira', { styles: { 0: 'stone' } });
    assert.deepEqual(store.layouts(), { Site: { placed: { '1,1': 'bench', '2,2': 'lamp' } }, mira: { styles: { 0: 'stone' } } });
    store.setLayout('Site', { placed: { '3,3': 'tree' } });
    assert.deepEqual(store.layouts().Site, { placed: { '3,3': 'tree' } });
    store.close();
  });
});

describe('section names', () => {
  it('groups repos by pattern, without case, with exact names first', () => {
    const sections = makeSectionNamer({ 'acme-*': 'Acme', 'shop-web*': 'Shop Web', 'acme-tools': 'Tools', 'a.b': 'Dots' });
    assert.deepEqual(['acme-core', 'Acme-PM', 'acme-tools', 'acme', 'shop-web', 'shop-web-app', 'shop-landing', 'axb', 'a.b'].map(sections.name),
      ['Acme', 'Acme', 'Tools', 'acme', 'Shop Web', 'Shop Web', 'shop-landing', 'axb', 'Dots']);
    assert.deepEqual(['Acme', 'Shop Web'].map(sections.name), ['Acme', 'Shop Web']); // a group's own name stays put
    assert.deepEqual(['Acme', 'Tools', 'Dots', 'mira'].map(sections.isGroup), [true, false, false, false]);
    assert.equal(makeSectionNamer({ a: 'Both', b: 'Both' }).isGroup('Both'), true);
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

  it('labels each session in a group with its own repo', () => {
    const grouped = makePlaceResolver({ '*': 'Code' }, gitMarker);
    assert.deepEqual(grouped(resolve('/code/app/src')), { system: 'Code', repo: 'app', root: resolve('/code/app') });
    assert.deepEqual(grouped(resolve('/code/mira/.claude/worktrees/hotfix')), { system: 'Code', worktree: 'hotfix', repo: 'mira', root: resolve('/code/mira') });
  });

  it('spells a Windows drive one way, so a repo is never two', { skip: process.platform !== 'win32' }, () => {
    const lower = resolve('/code/mira').replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
    assert.deepEqual(placeFor(`${lower}\\hub`), { system: 'mira', root: resolve('/code/mira') });
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
