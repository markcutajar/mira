import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { countCommits, gitLog, GrowthTracker, levelFor } from '../src/growth.ts';

const LOG = '\x1e\n\nsrc/app.ts\nREADME.md\n\x1e\n\nsrc/app.ts\n\x1e\n\ndocs/guide.txt\n\x1e\n\nnotes/plan.md\n';

describe('growth', () => {
  it('counts commits, and the ones that changed docs', () => {
    assert.deepEqual(countCommits(LOG), { commits: 4, docs: 3 });
    assert.deepEqual(countCommits(''), { commits: 0, docs: 0 });
  });

  it('turns counts into levels one to five', () => {
    const steps = [5, 15, 40, 100];
    assert.deepEqual([0, 4, 5, 39, 40, 500].map((n) => levelFor(n, steps)), [1, 1, 2, 3, 4, 5]);
  });

  it('adds up every repo a project worked in, and only reports a change', async () => {
    let changes = 0;
    const tracker = new GrowthTracker({
      systems: () => ['mira', 'quiet'],
      rootsFor: (system) => (system === 'mira' ? ['/a', '/b'] : []),
      onChange: () => { changes += 1; },
      read: async () => LOG,
    });
    await tracker.refresh();
    assert.deepEqual(tracker.get('mira'), { commits: 8, docs: 6, workshop: 2, library: 3 });
    assert.deepEqual(tracker.get('quiet'), { commits: 0, docs: 0, workshop: 1, library: 1 });
    await tracker.refresh();
    assert.equal(changes, 1);
  });

  describe('a real repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-growth-'));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('reads its recent commits, and nothing from a folder that is not a repo', async () => {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Mira', '-c', 'user.email=mira@example.com', ...args], { stdio: 'ignore' });
      git('init', '-q');
      writeFileSync(join(dir, 'app.ts'), 'one');
      git('add', '.');
      git('commit', '-q', '-m', 'Add the app');
      writeFileSync(join(dir, 'README.md'), '# Mira');
      git('add', '.');
      git('commit', '-q', '-m', 'Add a README');
      assert.deepEqual(countCommits(await gitLog(dir)), { commits: 2, docs: 1 });
      const plain = join(dir, '..', `${join(dir).split(/[\\/]/).pop()}-plain`);
      mkdirSync(plain, { recursive: true });
      assert.equal(await gitLog(plain), '');
      rmSync(plain, { recursive: true, force: true });
    });
  });
});
