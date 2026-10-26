import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { activeSessions, buildTurns, isInside, lastState, latestTitle, parseLines, readEntries, readStory } from '../src/claude-code/transcripts.ts';
import { makeCostOf } from '../src/pricing.ts';
import { conversation, lines, RESPONSE_USD, writeSession } from './fixtures.ts';

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

describe('the story', () => {
  const costOf = makeCostOf();
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);
  const turns = buildTurns(parseLines(lines(conversation)), costOf);

  it('groups entries into turns by prompt', () => {
    assert.deepEqual(turns.map((t) => [t.id, t.from, t.prompt, t.state]), [
      ['p-1', 'you', 'Fix the bug', 'done'],
      ['p-2', 'you', '/model claude-fable-5-1', 'done'],
      ['p-4', 'agent', 'Agent "Explore" finished', 'interrupted'],
      ['p-5', 'you', 'Next', 'running'],
    ]);
  });

  it('keeps replies and tool calls in order, marks failed tools and skips sidechain and thinking', () => {
    assert.deepEqual(turns[0]?.steps, [
      { kind: 'text', text: 'Looking.' },
      { kind: 'tool', id: 't-1', name: 'Bash', summary: 'npm test', failed: true },
      { kind: 'text', text: 'Fixed.' },
    ]);
    assert.deepEqual(turns[1]?.steps, [{ kind: 'note', text: 'Set model to Fable' }]);
    assert.deepEqual(turns[2]?.steps, [{ kind: 'tool', id: 't-2', name: 'Agent', summary: 'Look around' }, { kind: 'note', text: 'Conversation compacted' }]);
  });

  it('counts each response once, however many lines it spans', () => {
    assert.deepEqual({ ...turns[0]?.own, costUsd: 0 }, { input: 20, output: 200, cacheRead: 2000, cacheWrite: 1000, costUsd: 0 });
    close(turns[0]?.own.costUsd ?? 0, 2 * RESPONSE_USD);
    assert.equal(turns[1]?.own.costUsd, 0);
    assert.equal(turns[3]?.contextTokens, 1510);
  });

  it('unwraps pasted text and drops context Claude Code added', () => {
    const text = 'Why?\n<pasted_content id="1">\nTraceback: boom\n</pasted_content><ide_selection>selected</ide_selection>';
    const [entry] = parseLines(lines([{ type: 'user', timestamp: '2026-10-25T18:00:00.000Z', promptId: 'p-9', message: { role: 'user', content: text } }]));
    assert.equal(entry?.kind === 'prompt' && entry.text, 'Why?\n\nTraceback: boom');
  });

  it('names models it has no price for instead of guessing', () => {
    const [turn] = buildTurns(parseLines(lines(conversation.slice(0, 6))), () => undefined);
    assert.deepEqual(turn?.own.unpriced, ['claude-opus-5-5']);
  });

  describe('read from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mira-story-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const transcript = writeSession(dir);

    it('attaches subagents to the tool call that started them and counts them in', () => {
      const story = readStory(transcript, { costOf, turns: 30 });
      assert.equal(story?.model, 'claude-opus-5-5');
      assert.equal(story?.earlier, 0);
      const agent = story?.turns[2]?.steps[0];
      assert.equal(agent?.kind === 'tool' && agent.helper?.name, 'Explore');
      assert.equal(agent?.kind === 'tool' && agent.helper?.tools, 1);
      assert.equal(agent?.kind === 'tool' && agent.helper?.state, 'done');
      close(story?.turns[2]?.usage.costUsd ?? 0, 3 * RESPONSE_USD); // its own response plus the subagent's two
      close(story?.usage.costUsd ?? 0, 6 * RESPONSE_USD);
    });

    it('returns the latest turns and says how many are left out', () => {
      const story = readStory(transcript, { costOf, turns: 1 });
      assert.deepEqual(story?.turns.map((t) => t.id), ['p-5']);
      assert.equal(story?.earlier, 3);
    });

    it("tells one subagent's story, and nothing for one that doesn't exist", () => {
      const story = readStory(transcript, { costOf, turns: 30, helper: 'a1' });
      assert.equal(story?.helperId, 'a1');
      assert.deepEqual(story?.turns.map((t) => [t.prompt, t.state]), [['Look around the repo', 'done']]);
      assert.equal(readStory(transcript, { costOf, turns: 30, helper: 'nope' }), null);
    });

    it('reads only what was added since the last read, and only whole lines', () => {
      const file = join(dir, 'growing.jsonl');
      writeFileSync(file, lines(conversation.slice(0, 2)));
      assert.equal(readEntries(file).length, 2);
      appendFileSync(file, JSON.stringify(conversation[5]).slice(0, 40));
      assert.equal(readEntries(file).length, 2);
      appendFileSync(file, `${JSON.stringify(conversation[5]).slice(40)}\n`);
      assert.equal(readEntries(file).length, 3);
    });
  });
});
