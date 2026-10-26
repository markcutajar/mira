# Mira hub

Receives Claude Code hook events, keeps the live picture of every session, and answers permission prompts while Mira is open in a browser. It runs on this machine only, at `http://127.0.0.1:4711`.

## Run it

```bash
npm start        # or: npm run dev, which restarts when the code changes
```

Then open `http://127.0.0.1:4711` for the status board: sessions grouped by project with their live status, the event stream, and prompts waiting for an answer. While the board is open and on screen with "Answer prompts here" ticked, permission prompts wait there for up to 60 seconds before the terminal asks. Session titles are read from the transcripts when the board needs them, and never stored.

On startup it rebuilds today's picture from stored events, then reads recent Claude Code transcripts to find sessions that ran while it was stopped. Everything it keeps is in `~/.mira`:

| Path | What |
|---|---|
| `mira.db` | Every event, in SQLite (decision 17) |
| `recordings/` | Payload shapes, as the step 0 recorder wrote them, while `recordShapes` is on |
| `config.json` | Optional settings, below |

## Settings

`~/.mira/config.json` is optional. Every field has a default:

```json
{
  "port": 4711,
  "systems": { "acme-core": "Acme", "acme-web": "Acme" },
  "permissionWaitSeconds": 60,
  "activeHours": 2,
  "recordShapes": true
}
```

- `systems` renames or groups sections. Keys are repo folder names; giving two folders the same name puts them in one section. Git worktrees join their main repo's section on their own, labelled with the worktree's folder name, so they need no entry here.
- `permissionWaitSeconds` is how long a prompt waits for Mira while Mira is open. Keep it below the `PermissionRequest` hook's timeout, which is 65 seconds.
- `activeHours` is how recent a transcript must be for its session to count as running at startup.

## Claude Code hooks

These go in `~/.claude/settings.json` under `"hooks"`. Watch-only hooks run `curl` in the background and fail silently when the hub is down (decision 20). `SessionEnd` runs in the foreground, so it isn't cut off as the session exits. Permission prompts get a direct HTTP hook (decision 18).

```json
{
  "PreToolUse": [{ "hooks": [{ "type": "command", "async": true, "timeout": 10, "command": "curl -s -m 5 -X POST -H 'Content-Type: application/json' -H \"X-Mira-At: $(date +%s%3N)\" --data-binary @- http://127.0.0.1:4711/ingest/claude-code > /dev/null 2>&1 || true" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "timeout": 5, "command": "curl -s -m 2 -X POST -H 'Content-Type: application/json' -H \"X-Mira-At: $(date +%s%3N)\" --data-binary @- http://127.0.0.1:4711/ingest/claude-code > /dev/null 2>&1 || true" }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:4711/hooks/permission", "timeout": 65 }] }]
}
```

The `PreToolUse` entry is repeated for `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `SubagentStart`, `SubagentStop`, `Notification` and `CwdChanged`.

## Endpoints

| Request | Use |
|---|---|
| `GET /` | The status board |
| `POST /ingest/claude-code` | Hook events from the background commands |
| `POST /hooks/permission` | Permission prompts, held for an answer while Mira is open |
| `GET /api/sessions` | Live sessions and prompts waiting for an answer |
| `GET /api/events?limit=100` | The most recent events |
| `GET /api/stream` | Live updates as Server-Sent Events. Add `?visible=0` for a viewer that isn't on screen. |
| `POST /api/presence` | `{ "viewer", "visible" }`: whether a viewer is on screen |
| `POST /api/prompts/:id` | `{ "decision": "allow" }`, `"deny"`, or `"terminal"` to hand the prompt back to the terminal at once |

## Safety

- It listens on `127.0.0.1` only. It refuses requests that carry another site's `Origin` or a different `Host`, so a web page can't inject events or answer a prompt.
- It stores events, never content: no prompts, tool input or output, or messages. The command a permission prompt shows is held in memory while it waits, and never stored.
