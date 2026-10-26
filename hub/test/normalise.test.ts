import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalise } from '../src/claude-code/normalise.ts';

const ctx = { at: '2026-10-25T18:31:47.221Z', system: 'mira' };
const base = { session_id: 's-1', transcript_path: 'C:\\Users\\markc\\.claude\\projects\\mira\\s-1.jsonl', cwd: 'C:\\code\\mira', permission_mode: 'default', prompt_id: 'p-1' };

describe('normalise', () => {
  it('keeps the tool name and drops its input and output', () => {
    const event = normalise({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', duration_ms: 1840.4, tool_input: { command: 'cat .env' }, tool_response: { stdout: 'SECRET=1' } }, ctx);
    assert.equal(event?.type, 'tool.finished');
    assert.equal(event?.status, 'working');
    assert.deepEqual(event?.detail, { tool: 'Bash', durationMs: 1840, permissionMode: 'default', cwd: base.cwd });
    assert.deepEqual(event?.ref, { transcript: base.transcript_path, promptId: 'p-1', toolUseId: 'toolu_1' });
    assert.doesNotMatch(JSON.stringify(event), /SECRET|cat \.env/);
  });

  it('never copies the prompt', () => {
    const event = normalise({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'refactor the auth module' }, ctx);
    assert.equal(event?.type, 'prompt.submitted');
    assert.doesNotMatch(JSON.stringify(event), /refactor/);
  });

  it('turns a session start into my-turn with its estimates', () => {
    const event = normalise({ ...base, hook_event_name: 'SessionStart', source: 'resume', context_tokens: 41200, estimated_cache_write_usd: 0.42 }, ctx);
    assert.equal(event?.status, 'my-turn');
    assert.equal(event?.detail?.reason, 'resume');
    assert.equal(event?.detail?.cwd, base.cwd);
    assert.deepEqual(event?.usage, { contextTokens: 41200, costUsd: 0.42, estimated: true });
  });

  it('leaves the status alone after compaction', () => {
    assert.equal(normalise({ ...base, hook_event_name: 'SessionStart', source: 'compact' }, ctx)?.status, undefined);
  });

  it('puts subagent events on the subagent', () => {
    const event = normalise({ ...base, hook_event_name: 'SubagentStart', agent_id: 'a-1', agent_type: 'Explore' }, ctx);
    assert.deepEqual(event?.actor, { kind: 'subagent', id: 'a-1', parent: 's-1', name: 'Explore' });
  });

  it('turns an idle prompt into turn.waiting without the message', () => {
    const event = normalise({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, ctx);
    assert.equal(event?.type, 'turn.waiting');
    assert.equal(event?.status, 'my-turn');
    assert.doesNotMatch(JSON.stringify(event), /waiting for your input/);
  });

  it('keeps the error type of a failed turn but not its text', () => {
    const event = normalise({ ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached' }, ctx);
    assert.equal(event?.status, 'failed');
    assert.equal(event?.detail?.reason, 'rate_limit');
    assert.doesNotMatch(JSON.stringify({ ...event, id: undefined }), /API Error|429/); // a random id can contain 429
  });

  it('records where a session moved', () => {
    const event = normalise({ ...base, hook_event_name: 'CwdChanged', old_cwd: 'C:\\code\\mira', new_cwd: 'C:\\code\\garden' }, ctx);
    assert.equal(event?.type, 'session.moved');
    assert.equal(event?.detail?.cwd, 'C:\\code\\garden');
    assert.equal(event?.detail?.previousCwd, 'C:\\code\\mira');
  });

  it('drops what it cannot use', () => {
    assert.equal(normalise({ ...base, hook_event_name: 'PreCompact' }, ctx), null);
    assert.equal(normalise({ hook_event_name: 'Stop' }, ctx), null);
    assert.equal(normalise({ ...base, hook_event_name: 'PreToolUse', tool_name: 'x'.repeat(200) }, ctx)?.detail?.tool, undefined);
  });
});
