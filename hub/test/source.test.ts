import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MiraEvent } from '../../contracts/src/index.ts';
import { claudeCode, stableId } from '../src/claude-code/source.ts';
import type { SessionView } from '../src/colony.ts';
import { makeCostOf } from '../src/pricing.ts';
import { RESPONSE_USD, writeSession } from './fixtures.ts';

describe('Claude Code source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-source-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const transcript = writeSession(dir);
  const source = claudeCode({ projectsDir: dir, placeFor: () => ({ system: 'mira' }), costOf: makeCostOf(), usageDelayMs: 0 });
  const session = (t: string): SessionView => ({ id: 's-1', source: 'claude-code', system: 'mira', status: 'my-turn', lastAt: '2026-10-25T18:00:31.000Z', transcript: t, seenIn: 'events', subagents: [] });

  it('reports token use for every finished turn it missed, once each', () => {
    const events = source.catchUp?.(0) ?? [];
    assert.deepEqual(events.map((e) => [e.actor.kind, e.ref?.promptId, e.at]), [
      ['session', 'p-1', '2026-10-25T18:00:04.000Z'],
      ['session', 'p-4', '2026-10-25T18:00:25.000Z'],
      ['subagent', 'p-4', '2026-10-25T18:00:26.000Z'],
    ]);
    const [first] = events;
    assert.equal(first?.type, 'usage.reported');
    assert.equal(first?.detail?.model, 'claude-opus-5-5');
    assert.deepEqual({ ...first?.usage, costUsd: undefined }, { inputTokens: 20, outputTokens: 200, cacheReadTokens: 2000, cacheWriteTokens: 1000, contextTokens: 1510, costUsd: undefined });
    assert.ok(Math.abs((first?.usage?.costUsd ?? 0) - 2 * RESPONSE_USD) < 1e-9);
    assert.deepEqual((source.catchUp?.(0) ?? []).map((e) => e.id), events.map((e) => e.id));
  });

  it('reports a turn and a subagent once they end', async () => {
    const emitted: MiraEvent[] = [];
    const base = { v: 1 as const, at: '2026-10-25T18:00:05.000Z', source: 'claude-code', system: 'mira' };
    source.followUp?.({ ...base, id: stableId('a'), actor: { kind: 'session', id: 's-1' }, type: 'turn.ended', status: 'my-turn', ref: { transcript, promptId: 'p-1' } }, (e) => emitted.push(e));
    source.followUp?.({ ...base, id: stableId('b'), actor: { kind: 'subagent', id: 'a1', parent: 's-1', name: 'Explore' }, type: 'subagent.stopped', status: 'ended', ref: { subagentTranscript: join(dir, 'project', 's-1', 'subagents', 'agent-a1.jsonl') } }, (e) => emitted.push(e));
    await new Promise((done) => setTimeout(done, 20));
    assert.deepEqual(emitted.map((e) => [e.actor.id, e.ref?.promptId]), [['s-1', 'p-1'], ['a1', 'p-4']]);
    assert.deepEqual(emitted.map((e) => e.id), (source.catchUp?.(0) ?? []).filter((e) => e.ref?.promptId === 'p-1' || e.actor.kind === 'subagent').map((e) => e.id));
  });

  it('tells the story and titles the session, but only from transcripts under Claude Code\'s folder', () => {
    assert.equal(source.story?.(session(transcript), { turns: 30 })?.turns.length, 4);
    assert.equal(source.title?.(session(transcript)), 'Fix the bug');
    assert.equal(source.story?.(session(join(tmpdir(), 'elsewhere.jsonl')), { turns: 30 }), null);
    assert.equal(source.story?.(session(transcript), { turns: 30, helper: '../../etc' }), null);
  });

  it('makes valid, repeatable UUIDs', () => {
    assert.equal(stableId('usage:s-1:p-1'), stableId('usage:s-1:p-1'));
    assert.notEqual(stableId('usage:s-1:p-1'), stableId('usage:s-1:p-2'));
    assert.match(stableId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
