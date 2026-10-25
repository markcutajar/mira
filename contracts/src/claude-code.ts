// How Claude Code hook events map onto the envelope: which event type each hook becomes,
// what status it implies, and whether it belongs to the session or one of its subagents.
// The hub's normaliser applies this table; payload fields it doesn't name are dropped.

import type { EventType, Status } from './envelope.ts';

export interface HookRule {
  type: EventType;
  status?: Status;
  actor: 'session' | 'subagent';
}

export const CLAUDE_CODE_HOOKS = {
  SessionStart: { type: 'session.started', status: 'my-turn', actor: 'session' },
  UserPromptSubmit: { type: 'prompt.submitted', status: 'working', actor: 'session' },
  PreToolUse: { type: 'tool.started', status: 'working', actor: 'session' },
  PostToolUse: { type: 'tool.finished', status: 'working', actor: 'session' },
  PostToolUseFailure: { type: 'tool.failed', status: 'working', actor: 'session' },
  PermissionRequest: { type: 'permission.requested', status: 'needs-me', actor: 'session' },
  PermissionDenied: { type: 'permission.denied', status: 'working', actor: 'session' },
  Stop: { type: 'turn.ended', status: 'my-turn', actor: 'session' },
  StopFailure: { type: 'turn.failed', status: 'failed', actor: 'session' },
  SubagentStart: { type: 'subagent.started', status: 'working', actor: 'subagent' },
  SubagentStop: { type: 'subagent.stopped', status: 'ended', actor: 'subagent' },
  CwdChanged: { type: 'session.moved', actor: 'session' },
  SessionEnd: { type: 'session.ended', status: 'ended', actor: 'session' },
  Notification: { type: 'notification', actor: 'session' },
} as const satisfies Record<string, HookRule>;

export type ClaudeCodeHook = keyof typeof CLAUDE_CODE_HOOKS;

/** Notifications only change status for these types; any other type is logged without one. */
export const CLAUDE_CODE_NOTIFICATION_STATUS: Record<string, Status> = {
  permission_prompt: 'needs-me',
  elicitation_dialog: 'needs-me',
  agent_needs_input: 'needs-me',
  idle_prompt: 'my-turn',
  agent_completed: 'my-turn',
};

/** `subtype` is the Notification's `notification_type`, or the SessionStart's `source`. */
export function ruleFor(hook: string, subtype?: string): HookRule | null {
  if (!Object.hasOwn(CLAUDE_CODE_HOOKS, hook)) return null;
  const rule: HookRule = CLAUDE_CODE_HOOKS[hook as ClaudeCodeHook];
  // Compaction can happen mid-turn, so a session restarting after it keeps its status.
  if (hook === 'SessionStart' && subtype === 'compact') return { type: rule.type, actor: rule.actor };
  if (hook === 'Notification' && subtype === 'idle_prompt') return { ...rule, type: 'turn.waiting', status: 'my-turn' };
  if (hook === 'Notification' && subtype) {
    const status = CLAUDE_CODE_NOTIFICATION_STATUS[subtype];
    return status ? { ...rule, status } : rule;
  }
  return rule;
}
