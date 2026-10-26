# Mira hub

Receives events from each agent source, keeps the live picture of every session, tells each session's story on demand, and answers Claude Code permission prompts while Mira is open in a browser. It runs on this machine only, at `http://127.0.0.1:4711`.

## Run it

```bash
npm start        # or: npm run dev, which restarts when the code changes
```

Then open `http://127.0.0.1:4711` for the status board: sessions grouped by project with their live status and estimated cost, the event stream, and prompts waiting for an answer. While the board is open and on screen with "Answer prompts here" ticked, permission prompts wait there for up to 60 seconds before the terminal asks.

Click a session's title to open its story: every turn with its prompt, replies and tool calls, the subagents it started, and tokens and estimated cost for each turn and the whole session. The latest turn starts unfolded and the panel follows the session live. A link to the board with `#session=<id>` opens that session's story. Titles and stories are read from the transcripts when needed, and never stored.

On startup it rebuilds today's picture from stored events, reads recent Claude Code transcripts to find sessions that ran while it was stopped, and stores the token counts of turns that ended in the last day. Everything it keeps is in `~/.mira`:

| Path | What |
|---|---|
| `mira.db` | Every event, including one usage event per finished turn, in SQLite (decisions 17 and 23) |
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
  "recordShapes": true,
  "prices": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 } }
}
```

- `systems` renames or groups sections. Keys are repo folder names; giving two folders the same name puts them in one section. Git worktrees join their main repo's section on their own, labelled with the worktree's folder name, so they need no entry here.
- `permissionWaitSeconds` is how long a prompt waits for Mira while Mira is open. Keep it below the `PermissionRequest` hook's timeout, which is 65 seconds.
- `activeHours` is how recent a transcript must be for its session to count as running at startup.
- `prices` overrides or adds model prices for cost estimates, in US dollars per million tokens. Cache writes default to 1.25 times input for five minutes and twice input for an hour; set `cacheWrite5m` or `cacheWrite1h` to change them. The built-in table, in [src/pricing.ts](src/pricing.ts), holds Anthropic's first-party API prices as of October 2026. On a subscription these are only a measure of use, not a bill.

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
| `POST /ingest/<source>` | Events from a source, for example `/ingest/claude-code` for the hook commands |
| `POST /hooks/permission` | Claude Code permission prompts, held for an answer while Mira is open |
| `GET /api/sessions` | Live sessions and prompts waiting for an answer |
| `GET /api/sessions/:id/story` | A session's story, read on demand. `?turns=30` sets how many recent turns; `?helper=<agent id>` tells one subagent's story instead. |
| `GET /api/events?limit=100` | The most recent events |
| `GET /api/stream` | Live updates as Server-Sent Events. Add `?visible=0` for a viewer that isn't on screen. |
| `POST /api/presence` | `{ "viewer", "visible" }`: whether a viewer is on screen |
| `POST /api/prompts/:id` | `{ "decision": "allow" }`, `"deny"`, or `"terminal"` to hand the prompt back to the terminal at once |

## Adding a source

Each source is an adapter (decision 22), defined in [src/sources.ts](src/sources.ts). Every piece is optional: `ingest` turns what the source posts to `/ingest/<id>` into an event, `discover` finds its sessions at startup, `catchUp` fills in what was missed while the hub was stopped, `followUp` adds events that follow from one just recorded, `title` names a session, and `story` tells it for the panel. Claude Code's adapter is [src/claude-code/source.ts](src/claude-code/source.ts). To add an agent, write its adapter, add it to the list in [src/main.ts](src/main.ts), and point the agent's hooks at `/ingest/<id>`.

## Safety

- It listens on `127.0.0.1` only. It refuses requests that carry another site's `Origin`, a browser's mark that they came from another site (`Sec-Fetch-Site`), or a different `Host`, so a web page can't inject events, answer a prompt or read a story.
- It stores events, never content: no prompts, tool input or output, or messages. The command a permission prompt shows is held in memory while it waits, and never stored.
- Stories are read from transcripts when asked for, and only from files under `~/.claude/projects`, whatever path a hook payload names.
