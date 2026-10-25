import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Colony } from '../src/colony.ts';

let n = 0;
function ev(type: MiraEvent['type'], status: MiraEvent['status'], second: number, extra: Partial<MiraEvent> = {}): MiraEvent {
  n += 1;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    at: `2026-10-25T18:00:${String(second).padStart(2, '0')}.000Z`,
    source: 'claude-code',
    system: 'mira',
    actor: { kind: 'session', id: 's-1' },
    type,
    ...(status ? { status } : {}),
    ...extra,
  };
}
const statusOf = (colony: Colony, id = 's-1') => colony.snapshot(Date.parse('2026-10-25T18:30:00Z')).find((s) => s.id === id)?.status;

describe('Colony', () => {
  it('follows a normal turn', () => {
    const colony = new Colony();
    colony.apply(ev('prompt.submitted', 'working', 1, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(colony), 'working');
    colony.apply(ev('turn.ended', 'my-turn', 9, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(colony), 'my-turn');
  });

  it('ignores an event older than the status it shows', () => {
    const colony = new Colony();
    colony.apply(ev('turn.ended', 'my-turn', 9));
    colony.apply(ev('tool.finished', 'working', 8));
    assert.equal(statusOf(colony), 'my-turn');
  });

  it('ignores stragglers from a turn that has ended', () => {
    const colony = new Colony();
    colony.apply(ev('turn.ended', 'my-turn', 9, { ref: { promptId: 'p-1' } }));
    colony.apply(ev('tool.finished', 'working', 10, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(colony), 'my-turn');
    colony.apply(ev('prompt.submitted', 'working', 20, { ref: { promptId: 'p-2' } }));
    assert.equal(statusOf(colony), 'working');
  });

  it('keeps needs-me until the tool actually runs or is denied', () => {
    const colony = new Colony();
    colony.apply(ev('permission.requested', 'needs-me', 5));
    colony.apply(ev('tool.started', 'working', 6));
    assert.equal(statusOf(colony), 'needs-me');
    colony.apply(ev('tool.finished', 'working', 7));
    assert.equal(statusOf(colony), 'working');
  });

  it('tracks subagents without changing the session status', () => {
    const colony = new Colony();
    colony.apply(ev('turn.ended', 'my-turn', 5));
    colony.apply(ev('subagent.started', 'working', 6, { actor: { kind: 'subagent', id: 'a-1', parent: 's-1', name: 'Explore' } }));
    const session = colony.snapshot(Date.parse('2026-10-25T18:30:00Z'))[0];
    assert.equal(session?.status, 'my-turn');
    assert.deepEqual(session?.subagents.map((s) => [s.name, s.status]), [['Explore', 'working']]);
  });

  it('seeds sessions from transcripts unless events know more', () => {
    const colony = new Colony();
    colony.apply(ev('turn.ended', 'my-turn', 30));
    colony.seed([
      { sessionId: 's-1', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-10-25T18:00:10.000Z', status: 'working', transcript: 't1' },
      { sessionId: 's-2', system: 'garden', cwd: 'C:\\code\\garden', lastAt: '2026-10-25T18:00:20.000Z', status: 'working', transcript: 't2' },
    ]);
    assert.equal(statusOf(colony, 's-1'), 'my-turn');
    const found = colony.snapshot(Date.parse('2026-10-25T18:30:00Z')).find((s) => s.id === 's-2');
    assert.equal(found?.status, 'working');
    assert.equal(found?.seenIn, 'transcript');
  });

  it('hides sessions an hour after they end', () => {
    const colony = new Colony();
    colony.apply(ev('session.ended', 'ended', 0));
    assert.equal(colony.snapshot(Date.parse('2026-10-25T18:30:00Z')).length, 1);
    assert.equal(colony.snapshot(Date.parse('2026-10-25T19:30:00Z')).length, 0);
  });
});
