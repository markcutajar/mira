import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { Roster } from '../src/roster.ts';

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
const statusOf = (roster: Roster, id = 's-1') => roster.snapshot(Date.parse('2026-10-25T18:30:00Z')).find((s) => s.id === id)?.status;

describe('Roster', () => {
  it('follows a normal turn', () => {
    const roster = new Roster();
    roster.apply(ev('prompt.submitted', 'working', 1, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(roster), 'working');
    roster.apply(ev('turn.ended', 'my-turn', 9, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(roster), 'my-turn');
  });

  it('notes when a session calls for me: needing me, or a turn ending or failing, not only starting', () => {
    const roster = new Roster();
    roster.apply(ev('session.started', 'my-turn', 1));
    assert.equal(roster.get('s-1')?.calledAt, undefined);
    roster.apply(ev('prompt.submitted', 'working', 2, { ref: { promptId: 'p-1' } }));
    roster.apply(ev('permission.requested', 'needs-me', 4, { ref: { promptId: 'p-1' } }));
    assert.equal(roster.get('s-1')?.calledAt, '2026-10-25T18:00:04.000Z');
    roster.apply(ev('turn.ended', 'my-turn', 9, { ref: { promptId: 'p-1' } }));
    assert.equal(roster.get('s-1')?.calledAt, '2026-10-25T18:00:09.000Z');
    // A reminder that it's still my turn isn't a new call.
    roster.apply(ev('turn.waiting', 'my-turn', 30));
    assert.equal(roster.get('s-1')?.calledAt, '2026-10-25T18:00:09.000Z');
    roster.apply(ev('prompt.submitted', 'working', 40, { ref: { promptId: 'p-2' } }));
    roster.apply(ev('turn.failed', 'failed', 50, { ref: { promptId: 'p-2' } }));
    assert.equal(roster.get('s-1')?.calledAt, '2026-10-25T18:00:50.000Z');
  });

  it('ignores an event older than the status it shows', () => {
    const roster = new Roster();
    roster.apply(ev('turn.ended', 'my-turn', 9));
    roster.apply(ev('tool.finished', 'working', 8));
    assert.equal(statusOf(roster), 'my-turn');
  });

  it('ignores stragglers from a turn that has ended', () => {
    const roster = new Roster();
    roster.apply(ev('turn.ended', 'my-turn', 9, { ref: { promptId: 'p-1' } }));
    roster.apply(ev('tool.finished', 'working', 10, { ref: { promptId: 'p-1' } }));
    assert.equal(statusOf(roster), 'my-turn');
    roster.apply(ev('prompt.submitted', 'working', 20, { ref: { promptId: 'p-2' } }));
    assert.equal(statusOf(roster), 'working');
  });

  it('keeps needs-me until the tool actually runs or is denied', () => {
    const roster = new Roster();
    roster.apply(ev('permission.requested', 'needs-me', 5));
    roster.apply(ev('tool.started', 'working', 6));
    assert.equal(statusOf(roster), 'needs-me');
    roster.apply(ev('tool.finished', 'working', 7));
    assert.equal(statusOf(roster), 'working');
  });

  it('tracks subagents without changing the session status', () => {
    const roster = new Roster();
    roster.apply(ev('turn.ended', 'my-turn', 5));
    roster.apply(ev('subagent.started', 'working', 6, { actor: { kind: 'subagent', id: 'a-1', parent: 's-1', name: 'Explore' } }));
    const session = roster.snapshot(Date.parse('2026-10-25T18:30:00Z'))[0];
    assert.equal(session?.status, 'my-turn');
    assert.deepEqual(session?.subagents.map((s) => [s.name, s.status]), [['Explore', 'working']]);
  });

  it('seeds sessions from transcripts unless events know more', () => {
    const roster = new Roster();
    roster.apply(ev('turn.ended', 'my-turn', 30));
    roster.seed('claude-code', [
      { sessionId: 's-1', system: 'mira', cwd: 'C:\\code\\mira', lastAt: '2026-10-25T18:00:10.000Z', status: 'working', transcript: 't1' },
      { sessionId: 's-2', system: 'garden', cwd: 'C:\\code\\garden', lastAt: '2026-10-25T18:00:20.000Z', status: 'working', transcript: 't2' },
    ]);
    assert.equal(statusOf(roster, 's-1'), 'my-turn');
    const found = roster.snapshot(Date.parse('2026-10-25T18:30:00Z')).find((s) => s.id === 's-2');
    assert.equal(found?.status, 'working');
    assert.equal(found?.seenIn, 'transcript');
  });

  it('adds up token use for sessions it knows, and never revives one from usage alone', () => {
    const roster = new Roster();
    roster.apply(ev('turn.ended', 'my-turn', 5));
    const usage = { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 500, costUsd: 0.25 };
    roster.apply(ev('usage.reported', undefined, 6, { usage }));
    roster.apply(ev('usage.reported', undefined, 7, { usage, actor: { kind: 'subagent', id: 'a-1', parent: 's-1' } }));
    roster.apply(ev('usage.reported', undefined, 8, { usage, actor: { kind: 'session', id: 's-old' } }));
    const [session, ...others] = roster.snapshot(Date.parse('2026-10-25T18:30:00Z'));
    assert.deepEqual(session?.usage, { tokens: 3220, costUsd: 0.5 });
    assert.equal(session?.lastAt, '2026-10-25T18:00:05.000Z');
    assert.deepEqual(session?.subagents, []);
    assert.equal(others.length, 0);
  });

  it('keeps a session in its project and folder when its shell moves elsewhere', () => {
    const roster = new Roster();
    roster.apply(ev('prompt.submitted', 'working', 1, { detail: { cwd: 'C:\\code\\mira' } }));
    roster.apply(ev('session.moved', undefined, 2, { system: 'projects', detail: { cwd: 'C:\\Users\\me\\.claude\\projects', previousCwd: 'C:\\code\\mira' } }));
    const [session] = roster.snapshot(Date.parse('2026-10-25T18:30:00Z'));
    assert.equal(session?.system, 'mira');
    assert.equal(session?.cwd, 'C:\\code\\mira');
  });

  it('lets quiet sessions go: working ones after an hour, others after twelve, never one waiting on me', () => {
    const roster = new Roster();
    roster.apply(ev('prompt.submitted', 'working', 0, { actor: { kind: 'session', id: 'busy' } }));
    roster.apply(ev('turn.ended', 'my-turn', 0, { actor: { kind: 'session', id: 'idle' } }));
    roster.apply(ev('permission.requested', 'needs-me', 0, { actor: { kind: 'session', id: 'asking' } }));
    const shown = (at: string) => roster.snapshot(Date.parse(at)).map((s) => s.id).sort();
    assert.deepEqual(shown('2026-10-25T18:59:00Z'), ['asking', 'busy', 'idle']);
    assert.deepEqual(shown('2026-10-25T19:01:00Z'), ['asking', 'idle']);
    assert.deepEqual(shown('2026-10-26T06:01:00Z'), ['asking']);
    const patient = new Roster({ workingMs: 3 * 60 * 60 * 1000 });
    patient.apply(ev('prompt.submitted', 'working', 0));
    assert.equal(patient.snapshot(Date.parse('2026-10-25T20:00:00Z')).length, 1);
  });

  it('hides sessions five minutes after they end', () => {
    const roster = new Roster();
    roster.apply(ev('session.ended', 'ended', 0));
    assert.equal(roster.snapshot(Date.parse('2026-10-25T18:04:00Z')).length, 1);
    assert.equal(roster.snapshot(Date.parse('2026-10-25T18:06:00Z')).length, 0);
  });
});
