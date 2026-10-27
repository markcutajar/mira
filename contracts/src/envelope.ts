// The Mira event envelope: the one shape every source's events are normalised to.
// Strict objects reject unknown fields, so a source can't slip content (prompts, file
// contents, command output, error text) into an event. Mira stores pointers, not copies.

import * as z from 'zod';

export const CONTRACT_VERSION = 1;

/** The agent an event came from (decision 22): `claude-code`, or any agent a connector brings (decision 50). */
export const Source = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lower-case letters, digits and dashes');
export type Source = z.infer<typeof Source>;

export const Status = z.enum(['working', 'needs-me', 'my-turn', 'failed', 'ended']);
export type Status = z.infer<typeof Status>;

export const EventType = z.enum([
  // Claude Code sessions
  'session.started',
  'session.moved',
  'session.ended',
  'prompt.submitted',
  'turn.ended',
  'turn.waiting',
  'turn.failed',
  'tool.started',
  'tool.finished',
  'tool.failed',
  'permission.requested',
  'permission.answered',
  'permission.denied',
  'subagent.started',
  'subagent.stopped',
  'notification',
  'usage.reported',
]);
export type EventType = z.infer<typeof EventType>;

const id = z.string().min(1).max(200);
const path = z.string().min(1).max(1024);
const label = z.string().min(1).max(80);
const count = z.number().int().nonnegative();

export const Actor = z.strictObject({
  kind: z.enum(['session', 'subagent']),
  id,
  /** The session a subagent belongs to. */
  parent: id.optional(),
  /** Display name: a subagent's type. */
  name: label.optional(),
});
export type Actor = z.infer<typeof Actor>;

/** Facts small enough to show at a glance: names, enums, counts and paths, never content. */
export const Detail = z.strictObject({
  tool: label.optional(),
  /** Claude Code `notification_type`, e.g. `permission_prompt`, `idle_prompt`. */
  notification: label.optional(),
  /** A short code: why a session started or ended, or which error stopped a turn (`rate_limit`). */
  reason: label.optional(),
  decision: z.enum(['allow', 'deny']).optional(),
  answeredBy: z.enum(['mira', 'terminal']).optional(),
  durationMs: count.optional(),
  interrupted: z.boolean().optional(),
  permissionMode: label.optional(),
  /** The model that did the work, e.g. `claude-opus-5-5`. */
  model: label.optional(),
  cwd: path.optional(),
  previousCwd: path.optional(),
});
export type Detail = z.infer<typeof Detail>;

export const Usage = z.strictObject({
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  contextTokens: count.optional(),
  costUsd: z.number().nonnegative().optional(),
  /** True when the source only estimated the numbers. */
  estimated: z.boolean().optional(),
});
export type Usage = z.infer<typeof Usage>;

/** Pointers for fetching full content on demand. */
export const Ref = z.strictObject({
  transcript: path.optional(),
  subagentTranscript: path.optional(),
  promptId: id.optional(),
  toolUseId: id.optional(),
});
export type Ref = z.infer<typeof Ref>;

export const MiraEvent = z.strictObject({
  v: z.literal(CONTRACT_VERSION),
  id: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  source: Source,
  /** The project the event belongs to, which is one section of the island. */
  system: z.string().min(1).max(80),
  actor: Actor,
  type: EventType,
  /** The status this event implies for its actor, when it implies one. */
  status: Status.optional(),
  detail: Detail.optional(),
  usage: Usage.optional(),
  ref: Ref.optional(),
});
export type MiraEvent = z.infer<typeof MiraEvent>;
