# Mira event contract

**Draft, version 1.** Every source's events are normalised to one envelope, so the hub, the status board and the sky only ever handle one shape.

- **Source of truth:** [src/envelope.ts](src/envelope.ts), written with Zod. It gives the hub TypeScript types and runtime validation from one definition.
- **For other languages:** [schema/mira-event.schema.json](schema/mira-event.schema.json) is the same envelope as JSON Schema, for any client outside TypeScript. Regenerate it with `npm run contract:schema`. The tests fail while it is stale.
- **Claude Code mapping:** [src/claude-code.ts](src/claude-code.ts), the table the hub's normaliser applies.

## The envelope

| Field | Meaning |
|---|---|
| `v` | Contract version, currently `1`. The hub rejects versions it doesn't know. |
| `id` | A UUID for the event, assigned by the hub. A usage event's ID is derived from its turn, so the same turn always gets the same ID. |
| `at` | When it happened, ISO 8601 with offset. |
| `source` | The agent it came from: `claude-code`, or any other source's short ID in lower-case letters, digits and dashes (decision 22). |
| `system` | The project the event belongs to, which is one section of the island. |
| `actor` | Who: `{ kind, id, parent?, name? }`, where `kind` is `session` or `subagent`. A subagent's `parent` is its session. |
| `type` | What happened, for example `tool.started` or `permission.requested`. |
| `status` | The status this event implies for its actor, when it implies one: `working`, `waiting`, `needs-me`, `my-turn`, `failed` or `ended`. `waiting` means its turn ended while work it started runs on, and it carries on by itself when that work reports back. |
| `detail` | Small facts to show at a glance: tool name, notification type, a reason code, a duration, a model, a working directory. |
| `usage` | Tokens and cost, when known. A cost the hub worked out from its price table is an estimate. |
| `ref` | Pointers for fetching content on demand: transcript paths, and prompt and tool-use IDs. |

## Rules

- **No content.** Every object is strict, so unknown fields are rejected, and text fields are short. Prompts, file contents, command output, assistant messages and error text never enter an event. Panels fetch them from the source when they open.
- **Status.** An actor's status is the status of its latest event that carries one. Subagent events never change their session's status.
- **System.** For Claude Code, the hub maps a session's working directory to a system. By default the system is the repo's folder name, so a new project gets its own section with no setup. A config file only renames or groups projects. A session stays in the system it started in: `session.moved` records its shell changing folder, but doesn't move it (decision 27).
- **Versioning.** Adding an optional field or a new event type is not breaking. Renaming or removing anything, or changing a meaning, bumps `v`.

## Claude Code hooks

Every event also keeps the session ID as `actor.id`, the working directory as `detail.cwd`, the transcript path as `ref.transcript` and the prompt ID as `ref.promptId` when the hook sends them.

| Hook | Event type | Status | Kept from the payload |
|---|---|---|---|
| `SessionStart` | `session.started` | `my-turn`, or unchanged after compaction | `source` as `reason`; permission mode; `context_tokens` and `estimated_cache_write_usd` as estimated usage |
| `UserPromptSubmit` | `prompt.submitted` | `working` | Prompt ID only, never the prompt |
| `PreToolUse` | `tool.started` | `working` | Tool name, tool-use ID |
| `PostToolUse` | `tool.finished` | `working` | Tool name, duration |
| `PostToolUseFailure` | `tool.failed` | `working` | Tool name, whether it was interrupted; not the error text |
| `PermissionRequest` | `permission.requested` | `needs-me` | Tool name. The hub holds the request open so Mira can answer it, but doesn't store the command. |
| `PermissionDenied` | `permission.denied` | `working` | Tool name |
| `Notification` | `notification` | `needs-me` for `permission_prompt`, `elicitation_dialog` and `agent_needs_input`; `my-turn` for `agent_completed`; otherwise unchanged | Notification type, not the message |
| `Notification` (`idle_prompt`) | `turn.waiting` | `my-turn` | |
| `Stop` | `turn.ended` | `my-turn`, or `waiting` while work it started runs on (below) | The kind of each task it waits on, as `waitingOn`; never a task's command or description, nor the last assistant message |
| `StopFailure` | `turn.failed` | `failed` | Error type (`rate_limit`, `overloaded`…) as `reason` |
| `SubagentStart` | `subagent.started` | `working`, on the subagent | Agent type as the subagent's name, session as its parent |
| `SubagentStop` | `subagent.stopped` | `ended`, on the subagent | Subagent transcript path |
| `CwdChanged` | `session.moved` | unchanged | New and previous working directory. The event belongs to the session's project, and doesn't move the session (decision 27). |
| `SessionEnd` | `session.ended` | `ended` | Reason |
| Mira answers a prompt | `permission.answered` | `working` | `decision` and `answeredBy: mira` |
| The transcript reader, after a turn ends | `usage.reported` | unchanged | The turn's input, output and cache tokens, the context size, the model as `detail.model`, and estimated cost. A subagent's turns are reported on the subagent. |

**Waiting.** `Stop` lists the session's background tasks still in flight. The turn ends `waiting` when one of them is a subagent, which always reports back, or wasn't running when the session's previous turn ended, such as a script it started this turn. One still running from before, like a dev server, doesn't count, so the turn ends `my-turn`. The hub remembers each session's tasks from its last `Stop` in memory; for a session it met only after starting, only subagents count (decision 56).

**Usage.** No hook carries token counts, which the recordings confirmed, so `usage.reported` comes from the transcript reader, the one module that parses Claude Code transcripts (decision 23). There's one event per finished turn, and its ID is derived from the actor and the turn, so the live report and the startup catch-up never count a turn twice. `costUsd` is the hub's estimate from its price table, left out for a model with no price. `SessionStart` gives estimates when a session resumes.

## Open questions

- **Answers given in the terminal.** Hooks don't report that you answered a prompt in the terminal. The hub can infer it: `tool.finished` after `permission.requested` means allowed, `permission.denied` means denied.
- **Sessions that vanish.** A session that crashes sends no `SessionEnd`. The hub could mark a session ended after some hours with no events.
- **A `SubagentStop` with no `SubagentStart`** turned up once in the recordings. The hub should create the subagent on whichever event arrives first.
