// A small Claude Code transcript in the shape real ones have, for the story and source tests.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = 'C:\\code\\mira';
const at = (second: number) => `2026-10-25T18:00:${String(second).padStart(2, '0')}.000Z`;
// Each response costs $0.00624 on Opus 5.5: 10 in, 100 out, 1,000 cache reads, 500 one-hour cache writes.
export const RESPONSE_USD = 0.00624;
const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 } };

const user = (second: number, promptId: string, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', timestamp: at(second), sessionId: 's-1', cwd, promptId, message: { role: 'user', content }, ...extra });
const assistant = (second: number, id: string, content: unknown[], stop: string | null) =>
  ({ type: 'assistant', timestamp: at(second), sessionId: 's-1', cwd, message: { id, model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: stop, usage } });
const result = (second: number, promptId: string, toolUseId: string, isError: boolean) =>
  user(second, promptId, [{ type: 'tool_result', tool_use_id: toolUseId, content: 'output', is_error: isError }], { toolUseResult: { stdout: 'output' } });

export const conversation = [
  user(0, 'p-1', 'Fix the bug<system-reminder>hidden context</system-reminder>', { origin: { kind: 'human' } }),
  assistant(1, 'm-1', [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Looking.' }], null),
  assistant(2, 'm-1', [{ type: 'tool_use', id: 't-1', name: 'Bash', input: { command: 'npm test' } }], 'tool_use'), // same response, same usage
  result(3, 'p-1', 't-1', true),
  { type: 'assistant', timestamp: at(3), isSidechain: true, message: { id: 'side', content: [{ type: 'text', text: 'not in the main story' }], usage } },
  assistant(4, 'm-2', [{ type: 'text', text: 'Fixed.' }], 'end_turn'),
  { type: 'ai-title', aiTitle: 'Fix the bug', sessionId: 's-1' },
  user(10, 'p-2', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-fable-5-1</command-args>'),
  user(11, 'p-3', '<local-command-stdout>Set model to Fable</local-command-stdout>'),
  user(20, 'p-4', '<task-notification>\n<summary>Agent "Explore" finished</summary>\n</task-notification>', { origin: { kind: 'task-notification' } }),
  assistant(21, 'm-3', [{ type: 'tool_use', id: 't-2', name: 'Agent', input: { description: 'Look around', subagent_type: 'Explore', prompt: 'long prompt' } }], 'tool_use'),
  user(22, 'p-4', [{ type: 'text', text: '[Request interrupted by user]' }]),
  { type: 'system', subtype: 'compact_boundary', timestamp: at(25), content: 'Conversation compacted' },
  user(30, 'p-5', 'Next'),
  assistant(31, 'm-4', [{ type: 'tool_use', id: 't-3', name: 'Read', input: { file_path: 'C:\\code\\mira\\README.md' } }], 'tool_use'),
];

export const helper = [
  { ...user(21, 'p-4', 'Look around the repo'), isSidechain: true, agentId: 'a1' },
  { ...assistant(23, 'h-1', [{ type: 'tool_use', id: 'ht-1', name: 'Grep', input: { pattern: 'TODO' } }], 'tool_use'), isSidechain: true },
  { ...result(24, 'p-4', 'ht-1', false), isSidechain: true },
  { ...assistant(26, 'h-2', [{ type: 'text', text: 'Found two TODOs.' }], 'end_turn'), isSidechain: true },
];

export const lines = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;

/** Writes the conversation and its one subagent under `<projects>/project/`, and returns the transcript path. */
export function writeSession(projects: string): string {
  const project = join(projects, 'project');
  mkdirSync(join(project, 's-1', 'subagents'), { recursive: true });
  const transcript = join(project, 's-1.jsonl');
  writeFileSync(transcript, `not json\n${lines(conversation)}`);
  writeFileSync(join(project, 's-1', 'subagents', 'agent-a1.jsonl'), lines(helper));
  writeFileSync(join(project, 's-1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Look around', toolUseId: 't-2' }));
  return transcript;
}
