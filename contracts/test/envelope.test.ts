import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CLAUDE_CODE_HOOKS, MiraEvent, ruleFor } from '../src/index.ts';
import { schemaFile, schemaText } from '../scripts/schema.ts';

const sessionEvent = {
  v: 1,
  id: '3f0c2a52-4a4b-4f63-9f1e-2a1f6f0b7c11',
  at: '2026-10-25T09:41:13.529Z',
  source: 'claude-code',
  system: 'acme',
  actor: { kind: 'session', id: '4bf9236b-f319-4494-9463-c87d1cee89c6' },
  type: 'tool.finished',
  status: 'working',
  detail: { tool: 'Bash', durationMs: 1840, permissionMode: 'default', cwd: 'C:\\Users\\markc\\code\\acme-core' },
  ref: { transcript: 'C:\\Users\\markc\\.claude\\projects\\acme\\4bf9236b.jsonl', toolUseId: 'toolu_01', promptId: '5d5445d8' },
};

describe('MiraEvent', () => {
  it('accepts a Claude Code tool event', () => {
    assert.equal(MiraEvent.safeParse(sessionEvent).success, true);
  });

  it("accepts any agent's source ID, but only in its short form", () => {
    assert.equal(MiraEvent.safeParse({ ...sessionEvent, source: 'codex-cli' }).success, true);
    assert.equal(MiraEvent.safeParse({ ...sessionEvent, source: 'Codex CLI' }).success, false);
    assert.equal(MiraEvent.safeParse({ ...sessionEvent, source: 'x'.repeat(41) }).success, false);
  });

  it('rejects content at the top level', () => {
    assert.equal(MiraEvent.safeParse({ ...sessionEvent, prompt: 'refactor the auth module' }).success, false);
  });

  it('rejects content tucked into detail', () => {
    const event = { ...sessionEvent, detail: { ...sessionEvent.detail, command: 'cat .env' } };
    assert.equal(MiraEvent.safeParse(event).success, false);
  });

  it('rejects long text in short fields', () => {
    const event = { ...sessionEvent, detail: { reason: 'x'.repeat(500) } };
    assert.equal(MiraEvent.safeParse(event).success, false);
  });

  it('rejects other contract versions', () => {
    assert.equal(MiraEvent.safeParse({ ...sessionEvent, v: 2 }).success, false);
  });
});

describe('Claude Code hook rules', () => {
  // The hooks Mira subscribes to in ~/.claude/settings.json.
  const subscribed = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'SubagentStart', 'SubagentStop', 'Notification', 'CwdChanged'];

  it('has a rule for every subscribed hook', () => {
    for (const hook of subscribed) assert.ok(ruleFor(hook), `no rule for ${hook}`);
    assert.deepEqual(Object.keys(CLAUDE_CODE_HOOKS).sort(), [...subscribed].sort());
  });

  it('ignores hooks it does not know', () => {
    assert.equal(ruleFor('PreCompact'), null);
  });

  it('maps the waiting-on-me signals from the status vocabulary', () => {
    assert.equal(ruleFor('PermissionRequest')?.status, 'needs-me');
    assert.equal(ruleFor('Notification', 'permission_prompt')?.status, 'needs-me');
    assert.deepEqual(ruleFor('Notification', 'idle_prompt'), { type: 'turn.waiting', status: 'my-turn', actor: 'session' });
    assert.equal(ruleFor('Stop')?.status, 'my-turn');
    assert.equal(ruleFor('StopFailure')?.status, 'failed');
    assert.equal(ruleFor('SessionEnd')?.status, 'ended');
  });

  it('keeps the status when a session restarts after compaction', () => {
    assert.equal(ruleFor('SessionStart', 'startup')?.status, 'my-turn');
    assert.equal(ruleFor('SessionStart', 'resume')?.status, 'my-turn');
    assert.equal(ruleFor('SessionStart', 'compact')?.status, undefined);
  });

  it('logs other notifications without changing status', () => {
    assert.deepEqual(ruleFor('Notification', 'auth_success'), { type: 'notification', actor: 'session' });
  });

  it('puts subagent hooks on the subagent', () => {
    assert.equal(ruleFor('SubagentStart')?.actor, 'subagent');
    assert.equal(ruleFor('SubagentStop')?.actor, 'subagent');
  });
});

describe('JSON Schema', () => {
  it('is up to date with the envelope', () => {
    assert.equal(readFileSync(schemaFile, 'utf8'), schemaText(), 'run `npm run contract:schema`');
  });
});
