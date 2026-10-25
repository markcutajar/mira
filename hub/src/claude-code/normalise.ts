// Turns one Claude Code hook payload into a Mira event. Only the fields the contract names
// are copied across; tool input and output, prompts and messages are dropped here.

import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, MiraEvent, ruleFor } from '../../../contracts/src/index.ts';

export type HookPayload = Record<string, unknown>;

export interface NormaliseContext {
  at: string;
  system: string;
}

const text = (value: unknown, max: number) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined);
const label = (value: unknown) => text(value, 80);
const path = (value: unknown) => text(value, 1024);
const id = (value: unknown) => text(value, 200);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const kept = Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length ? (kept as T) : undefined;
}

export function normalise(payload: HookPayload, ctx: NormaliseContext): MiraEvent | null {
  const hook = label(payload.hook_event_name);
  const sessionId = id(payload.session_id);
  if (!hook || !sessionId) return null;
  const subtype = hook === 'Notification' ? label(payload.notification_type) : hook === 'SessionStart' ? label(payload.source) : undefined;
  const rule = ruleFor(hook, subtype);
  if (!rule) return null;

  const agentId = id(payload.agent_id);
  const actor = rule.actor === 'subagent' && agentId
    ? compact({ kind: 'subagent' as const, id: agentId, parent: sessionId, name: label(payload.agent_type) })
    : { kind: 'session' as const, id: sessionId };

  const reasons: Record<string, unknown> = { SessionStart: payload.source, SessionEnd: payload.reason, StopFailure: payload.error };
  const detail = compact({
    tool: label(payload.tool_name),
    notification: hook === 'Notification' ? label(payload.notification_type) : undefined,
    reason: label(reasons[hook]),
    durationMs: count(payload.duration_ms),
    interrupted: typeof payload.is_interrupt === 'boolean' ? payload.is_interrupt : undefined,
    permissionMode: label(payload.permission_mode),
    cwd: hook === 'CwdChanged' ? path(payload.new_cwd) : hook === 'SessionStart' ? path(payload.cwd) : undefined,
    previousCwd: hook === 'CwdChanged' ? path(payload.old_cwd) : undefined,
  });

  const estimate = hook === 'SessionStart'
    ? compact({ contextTokens: count(payload.context_tokens), costUsd: typeof payload.estimated_cache_write_usd === 'number' && payload.estimated_cache_write_usd >= 0 ? payload.estimated_cache_write_usd : undefined })
    : undefined;
  const usage = estimate ? { ...estimate, estimated: true } : undefined;

  const ref = compact({
    transcript: path(payload.transcript_path),
    subagentTranscript: hook === 'SubagentStop' ? path(payload.agent_transcript_path) : undefined,
    promptId: id(payload.prompt_id),
    toolUseId: id(payload.tool_use_id),
  });

  const event = compact({
    v: CONTRACT_VERSION,
    id: randomUUID(),
    at: ctx.at,
    source: 'claude-code' as const,
    system: ctx.system,
    actor,
    type: rule.type,
    status: rule.status,
    detail,
    usage,
    ref,
  });
  const parsed = MiraEvent.safeParse(event);
  return parsed.success ? parsed.data : null;
}
