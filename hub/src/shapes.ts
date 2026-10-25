// Keeps step 0 going: logs the shape of each raw hook payload (key names, value types, string
// lengths) to ~/.mira/recordings, with the same rules as tools/hook-recorder. No content is written.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const KEEP = new Set([
  'hook_event_name', 'session_id', 'prompt_id', 'cwd', 'transcript_path',
  'permission_mode', 'effort', 'agent_id', 'agent_type', 'agent_transcript_path',
  'tool_name', 'tool_use_id',
]);
const KEEP_FOR_EVENT: Record<string, string[]> = {
  SessionStart: ['source', 'model'],
  SessionEnd: ['reason'],
  StopFailure: ['error'],
  Notification: ['notification_type'],
};
const MAX_DEPTH = 4;

export function shape(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? 'array(0)' : { [`array(${value.length})`]: shape(value[0], depth + 1) };
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return `object(${Object.keys(value).length} keys)`;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

export function shapeLine(source: string, payload: Record<string, unknown>, bytes: number, at = new Date()) {
  const keep = new Set([...KEEP, ...(KEEP_FOR_EVENT[String(payload.hook_event_name)] ?? [])]);
  const values: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const keepString = keep.has(key) && typeof value === 'string';
    if (keepString || typeof value === 'number' || typeof value === 'boolean') values[key] = value;
    else rest[key] = shape(value);
  }
  return { received_at: at.toISOString(), source, bytes, values, shape: rest };
}

/** Returns a function that appends shape lines to one file per day, in order. */
export function shapeRecorder(dir: string) {
  let writes: Promise<unknown> = mkdir(dir, { recursive: true });
  return (source: string, payload: Record<string, unknown>, bytes: number) => {
    const line = shapeLine(source, payload, bytes);
    const file = join(dir, `hooks-${line.received_at.slice(0, 10)}.jsonl`);
    writes = writes.then(() => appendFile(file, `${JSON.stringify(line)}\n`)).catch((err: Error) => console.error(`shape log failed: ${err.message}`));
  };
}
