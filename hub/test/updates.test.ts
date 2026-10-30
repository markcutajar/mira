import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { takeUpdate } from '../src/updater.ts';
import { gitIn, inspect, Updates } from '../src/updates.ts';

// Throwaway repos: an upstream, a clone where new commits are made, and Mira's copy, which updates.
const root = mkdtempSync(join(tmpdir(), 'mira-updates-'));
const IDENTITY = ['-c', 'user.name=Mira Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
const run = (cwd: string, ...args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
let n = 0;
let upstream = '';
let author = '';
let copy = '';

function commit(where: string, file: string, text: string, subject: string) {
  writeFileSync(join(where, file), text);
  run(where, 'add', file);
  run(where, 'commit', '-q', '-m', subject);
}

beforeEach(() => {
  const here = join(root, String(++n));
  mkdirSync(here);
  upstream = join(here, 'upstream.git');
  author = join(here, 'author');
  copy = join(here, 'copy');
  run(here, 'init', '-q', '--bare', '-b', 'main', upstream);
  run(here, 'clone', '-q', upstream, author);
  commit(author, 'README.md', 'Mira\n', 'Start');
  commit(author, 'package.json', '{ "name": "mira" }\n', 'Add packages');
  commit(author, 'package-lock.json', '{ "lockfileVersion": 3 }\n', 'Lock packages');
  run(author, 'push', '-q', 'origin', 'main');
  run(here, 'clone', '-q', upstream, copy);
});

after(() => rmSync(root, { recursive: true, force: true }));

const steps = (install = async () => {}) => {
  const did: string[] = [];
  return {
    did,
    git: gitIn(copy),
    install: async () => { did.push('install'); await install(); },
    stopTerminals: async () => void did.push('stop terminals'),
    say: () => {},
  };
};

describe('updating Mira from its upstream (decision 60)', () => {
  it('finds new commits upstream and lists them', async () => {
    assert.equal((await inspect(gitIn(copy), { fetch: true })).state, 'current');
    commit(author, 'README.md', 'Mira, with settings\n', 'Add settings');
    run(author, 'push', '-q', 'origin', 'main');
    const status = await inspect(gitIn(copy), { fetch: true });
    assert.deepEqual([status.state, status.upstream, status.behind, status.changes?.map((c) => c.subject), status.packages], ['available', 'origin/main', 1, ['Add settings'], undefined]);
  });

  it('leaves a copy alone that has changes or commits of its own', async () => {
    commit(author, 'README.md', 'Mira, with settings\n', 'Add settings');
    run(author, 'push', '-q', 'origin', 'main');
    writeFileSync(join(copy, 'package.json'), '{ "name": "my-mira" }\n');
    const changed = await inspect(gitIn(copy), { fetch: true });
    assert.deepEqual([changed.state, changed.behind], ['blocked', 1]);
    assert.match(changed.reason ?? '', /changes of its own/);
    commit(copy, 'package.json', '{ "name": "my-mira" }\n', 'My own name');
    const ahead = await inspect(gitIn(copy), { fetch: false });
    assert.equal(ahead.state, 'blocked');
    assert.match(ahead.reason ?? '', /1 commit that origin\/main hasn't/);
    // A file nobody tracks is no change of the copy's.
    run(copy, 'reset', '-q', '--hard', 'origin/main~1');
    writeFileSync(join(copy, 'notes.txt'), 'mine\n');
    assert.equal((await inspect(gitIn(copy), { fetch: false })).state, 'available');
  });

  it("says when it can't tell: no git clone, or no branch upstream", async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    assert.equal((await inspect(gitIn(plain), { fetch: false })).state, 'unknown');
    run(copy, 'checkout', '-q', '-b', 'mine');
    const status = await inspect(gitIn(copy), { fetch: false });
    assert.equal(status.state, 'blocked');
    assert.match(status.reason ?? '', /doesn't track an upstream/);
  });

  it('fast-forwards the copy, installing packages only when they changed', async () => {
    commit(author, 'README.md', 'Mira, with settings\n', 'Add settings');
    run(author, 'push', '-q', 'origin', 'main');
    const plain = steps();
    const first = await takeUpdate(plain);
    assert.deepEqual([first.ok, first.to, plain.did], [true, run(author, 'rev-parse', 'HEAD'), []]);
    // A new script alone needs nothing installed; a new lock does.
    commit(author, 'package.json', '{ "name": "mira", "scripts": { "update": "node updater.ts" } }\n', 'Add a script');
    run(author, 'push', '-q', 'origin', 'main');
    const scripted = steps();
    assert.deepEqual([(await takeUpdate(scripted)).ok, scripted.did], [true, []]);
    commit(author, 'package-lock.json', '{ "lockfileVersion": 3, "packages": { "zod": "4" } }\n', 'Bump packages');
    run(author, 'push', '-q', 'origin', 'main');
    const packaged = steps();
    const second = await takeUpdate(packaged);
    assert.deepEqual([second.ok, packaged.did], [true, ['stop terminals', 'install']]);
    assert.equal((await inspect(gitIn(copy), { fetch: false })).state, 'current');
    const again = steps();
    assert.deepEqual([(await takeUpdate(again)).from === (await takeUpdate(again)).to, again.did], [true, []]);
  });

  it('goes back to where it was when the new packages fail to install', async () => {
    const before = run(copy, 'rev-parse', 'HEAD');
    commit(author, 'package-lock.json', '{ "lockfileVersion": 3, "packages": { "zod": "4" } }\n', 'Bump packages');
    run(author, 'push', '-q', 'origin', 'main');
    let tries = 0;
    const failing = steps(async () => { if (++tries === 1) throw new Error('EBUSY: electron.exe is in use'); });
    const outcome = await takeUpdate(failing);
    assert.deepEqual([outcome.ok, outcome.to, run(copy, 'rev-parse', 'HEAD'), failing.did], [false, before, before, ['stop terminals', 'install', 'install']]);
    assert.match(outcome.error ?? '', /EBUSY/);
  });

  it('hands over to the updater once, waiting for the hub and the app to close', async () => {
    commit(author, 'README.md', 'Mira, with settings\n', 'Add settings');
    run(author, 'push', '-q', 'origin', 'main');
    const launched: string[][] = [];
    let exited = 0;
    const seen: string[] = [];
    const updates = new Updates({ home: join(root, 'home'), repo: copy, launch: (args) => void launched.push(args), exit: () => void exited++, onChange: (s) => void seen.push(s.updating ? 'updating' : s.state) });
    assert.equal(updates.status().running, run(copy, 'rev-parse', '--short=7', 'HEAD'));
    assert.equal((await updates.check()).state, 'available');
    assert.equal(await updates.apply(4242), null);
    assert.deepEqual(launched, [['--after', `${process.pid},4242`, '--app']]);
    assert.equal(await updates.apply(), 'Mira is already updating.');
    await new Promise((done) => setTimeout(done, 600));
    assert.deepEqual([exited, seen], [1, ['available', 'available', 'updating']]);
    const current = new Updates({ home: join(root, 'home'), repo: author, launch: () => assert.fail('nothing to take'), exit: () => assert.fail('nothing to close for') });
    assert.equal(await current.apply(), 'Mira is up to date.');
  });
});
