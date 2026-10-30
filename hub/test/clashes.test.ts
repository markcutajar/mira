import { strict as assert } from 'node:assert';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Edits, findClashes } from '../src/clashes.ts';

describe('clashes', () => {
  const repo = resolve('/code/mira');
  const tree = resolve('/code/mira-tree');
  const server = join(repo, 'hub', 'server.ts');

  it('finds live sessions that edited the same file, each naming the other', () => {
    const edits = [
      { session: 'a', file: server, at: 1 },
      { session: 'b', file: server, at: 2 },
      { session: 'b', file: join(repo, 'README.md'), at: 3 },
      { session: 'c', file: join(repo, 'README.md'), at: 4 },
      // A worktree of the same repo is a different file.
      { session: 'd', file: join(tree, 'hub', 'server.ts'), at: 5 },
    ];
    const found = findClashes(edits, new Set(['a', 'b', 'd']));
    assert.deepEqual(Object.fromEntries(found), {
      a: [{ file: server, with: 'b' }],
      b: [{ file: server, with: 'a' }],
    });
    // One session editing a file twice is no clash.
    assert.equal(findClashes([{ session: 'a', file: server, at: 1 }, { session: 'a', file: server, at: 2 }], new Set(['a'])).size, 0);
  });

  it('matches a file however Windows spells it', { skip: process.platform !== 'win32' }, () => {
    const found = findClashes([{ session: 'a', file: 'C:\\Code\\Mira\\x.ts', at: 1 }, { session: 'b', file: 'c:/code/mira/x.ts', at: 2 }], new Set(['a', 'b']));
    assert.deepEqual(found.get('b'), [{ file: 'c:/code/mira/x.ts', with: 'a' }]);
  });

  it('keeps each session’s latest edit of a file, lets old ones go, and forgets a session', () => {
    const edits = new Edits();
    edits.note('a', server, 100);
    edits.note('b', server, 200);
    edits.note('a', server, 300);
    assert.deepEqual(edits.since(0), [{ session: 'b', file: server, at: 200 }, { session: 'a', file: server, at: 300 }]);
    assert.deepEqual(edits.since(250).map((e) => e.session), ['a']);
    assert.deepEqual(edits.since(0).map((e) => e.session), ['a']); // b's was let go
    edits.forget('a');
    assert.deepEqual(edits.since(0), []);
  });
});
