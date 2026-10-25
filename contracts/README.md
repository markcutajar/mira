# Mira event contract

**Draft, version 1.** Every source's events are normalised to one envelope, so the hub, the status board and the sky only ever handle one shape.

- **Source of truth:** [src/envelope.ts](src/envelope.ts), written with Zod. It gives the hub TypeScript types and runtime validation from one definition.
- **For other languages:** [schema/mira-event.schema.json](schema/mira-event.schema.json) is the same envelope as JSON Schema, for any client outside TypeScript. Regenerate it with `npm run contract:schema`. The tests fail while it is stale.
- **Claude Code mapping:** [src/claude-code.ts](src/claude-code.ts), the table the hub's normaliser applies.

## The envelope

| Field | Meaning |
|---|---|
| `v` | Contract version, currently `1`. The hub rejects versions it doesn't know. |
| `id` | A UUID for the event, assigned by the hub. |
| `at` | When it happened, ISO 8601 with offset. |
| `source` | `claude-code`. |
| `system` | The project the event belongs to, which is one section of the island. |
| `actor` | Who: `{ kind, id, parent?, name? }`, where `kind` is `session` or `subagent`. A subagent's `parent` is its session. |
| `type` | What happened, for example `tool.started` or `permission.requested`. |
| `status` | The status this event implies for its actor, when it implies one: `working`, `needs-me`, `my-turn`, `failed` or `ended`. |
| `detail` | Small facts to show at a glance: tool name, notification type, a reason code, a duration, a working directory. |
| `usage` | Tokens and cost, when known. |
| `ref` | Pointers for fetching content on demand: transcript paths, and prompt and tool-use IDs. |

## Rules

- **No content.** Every object is strict, so unknown fields are rejected, and text fields are short. Prompts, file contents, command output, assistant messages and error text never enter an event. Panels fetch them from the source when they open.
- **Status.** An actor's status is the status of its latest event that carries one. Subagent events never change their session's status.
- **System.** For Claude Code, the hub maps a session's working directory to a system. By default the system is the repo's folder name, so a new project gets its own section with no setup. A config file only renames or groups projects. `session.moved` can move a session to another system.
- **Versioning.** Adding an optional field or a new event type is not breaking. Renaming or removing anything, or changing a meaning, bumps `v`.

## Claude Code hooks

Every event also keeps the session ID as `actor.id`, the transcript path as `ref.transcript` and the prompt ID as `ref.promptId` when the hook sends them.

| Hook | Event type | Status | Kept from the payload |
|---|---|---|---|
| `SessionStart` | `session.started` | `my-turn`, or unchanged after compaction | `source` as `reason`; `cwd`, permission mode; `context_tokens` and `estimated_cache_write_usd` as estimated usage |
| `UserPromptSubmit` | `prompt.submitted` | `working` | Prompt ID only, never the prompt |
| `PreToolUse` | `tool.started` | `working` | Tool name, tool-use ID |
| `PostToolUse` | `tool.finished` | `working` | Tool name, duration |
| `PostToolUseFailure` | `tool.failed` | `working` | Tool name, whether it was interrupted; not the error text |
| `PermissionRequest` | `permission.requested` | `needs-me` | Tool name. The hub holds the request open so Mira can answer it, but doesn't store the command. |
| `PermissionDenied` | `permission.denied` | `working` | Tool name |
| `Notification` | `notification` | `needs-me` for `permission_prompt`, `elicitation_dialog` and `agent_needs_input`; `my-turn` for `agent_completed`; otherwise unchanged | Notification type, not the message |
| `Notification` (`idle_prompt`) | `turn.waiting` | `my-turn` | |
| `Stop` | `turn.ended` | `my-turn` | Nothing; not the last assistant message |
| `StopFailure` | `turn.failed` | `failed` | Error type (`rate_limit`, `overloaded`…) as `reason` |
| `SubagentStart` | `subagent.started` | `working`, on the subagent | Agent type as the subagent's name, session as its parent |
| `SubagentStop` | `subagent.stopped` | `ended`, on the subagent | Subagent transcript path |
| `CwdChanged` | `session.moved` | unchanged | New and previous working directory |
| `SessionEnd` | `session.ended` | `ended` | Reason |
| Mira answers a prompt | `permission.answered` | `working` | `decision` and `answeredBy: mira` |

**Usage.** No hook carries token counts, which the recordings confirmed. `usage.reported` events will come from the transcript reader, the one module that parses Claude Code transcripts. `SessionStart` gives estimates when a session resumes.

## Open questions

- **Answers given in the terminal.** Hooks don't report that you answered a prompt in the terminal. The hub can infer it: `tool.finished` after `permission.requested` means allowed, `permission.denied` means denied.
- **Sessions that vanish.** A session that crashes sends no `SessionEnd`. The hub could mark a session ended after some hours with no events.
- **A `SubagentStop` with no `SubagentStart`** turned up once in the recordings. The hub should create the subagent on whichever event arrives first.
