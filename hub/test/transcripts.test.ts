import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { activeSessions, isInside, lastState, latestTitle } from '../src/claude-code/transcripts.ts';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const msg = (type: 'user' | 'assistant', sessionId: string, timestamp: string, extra: Record<string, unknown> = {}) =>
  line({ type, sessionId, cwd: 'C:\\code\\mira', timestamp, message: { role: type, content: [] }, ...extra });

describe('lastState', () => {
  it('reads the latest main-conversation message and skips the rest', () => {
    const tail = [
      '{"type":"assistant","sessionI', // the cut-off start of a tail
      msg('user', 's-1', '2026-10-25T18:00:00.000Z'),
      msg('assistant', 's-1', '2026-10-25T18:00:05.000Z', { message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
      msg('assistant', 's-1', '2026-10-25T18:00:06.000Z', { isSidechain: true }),
      line({ type: 'ai-title', aiTitle: 'Mira', sessionId: 's-1' }),
      '',
    ].join('\n');
    assert.deepEqual(lastState(tail, 't.jsonl'), { sessionId: 's-1', cwd: 'C:\\code\\mira', lastAt: '2026-10-25T18:00:05.000Z', status: 'my-turn', transcript: 't.jsonl' });
  });

  it('counts a turn still in progress as working', () => {
    const tail = msg('assistant', 's-1', '2026-10-25T18:00:05.000Z', { message: { role: 'assistant', stop_reason: 'tool_use', content: [] } });
    assert.equal(lastState(tail, 't.jsonl')?.status, 'working');
  });

  it('returns nothing for a transcript it cannot read', () => {
    assert.equal(lastState('not json\n{"type":"summary"}', 't.jsonl'), null);
  });
});

describe('latestTitle', () => {
  it('takes the most recent title Claude Code wrote', () => {
    const tail = [line({ type: 'ai-title', aiTitle: 'First idea', sessionId: 's-1' }), msg('user', 's-1', '2026-10-25T18:00:00.000Z'), line({ type: 'ai-title', aiTitle: '  Mira hub status board  ', sessionId: 's-1' })].join('\n');
    assert.equal(latestTitle(tail), 'Mira hub status board');
  });

  it('caps long titles and copes with none', () => {
    assert.equal(latestTitle(line({ type: 'ai-title', aiTitle: 'x'.repeat(200) }))?.length, 80);
    assert.equal(latestTitle(msg('user', 's-1', '2026-10-25T18:00:00.000Z')), undefined);
  });
});

describe('isInside', () => {
  it('only accepts files under the folder', () => {
    const projects = join(tmpdir(), 'claude', 'projects');
    assert.equal(isInside(projects, join(projects, 'mira', 's-1.jsonl')), true);
    assert.equal(isInside(projects, join(projects, '..', 'settings.json')), false);
    assert.equal(isInside(projects, projects), false);
  });
});

describe('activeSessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mira-transcripts-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('finds recently active sessions and skips old ones', () => {
    mkdirSync(join(dir, 'project-a', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'project-a', 's-new.jsonl'), msg('user', 's-new', '2026-10-25T18:00:00.000Z'));
    writeFileSync(join(dir, 'project-a', 's-old.jsonl'), msg('user', 's-old', '2026-10-24T18:00:00.000Z'));
    writeFileSync(join(dir, 'project-a', 'notes.txt'), 'not a transcript');
    const dayAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, 'project-a', 's-old.jsonl'), dayAgo, dayAgo);
    const found = activeSessions(dir, Date.now() - 60 * 60 * 1000);
    assert.deepEqual(found.map((s) => s.sessionId), ['s-new']);
  });

  it('copes with a missing projects folder', () => {
    assert.deepEqual(activeSessions(join(dir, 'nope'), 0), []);
  });
});
