# Mira hub

Receives events from each agent source, keeps the live picture of every session, tells each session's story on demand, and answers Claude Code permission prompts while Mira is open in a browser. It runs on this machine only, at `http://127.0.0.1:4711`.

## Run it

```bash
npm start        # in this terminal; or npm run dev, which restarts when the code changes
```

To keep it running without a terminal (decision 34):

```bash
npm run hub:background   # start it in the background, logging to ~/.mira/hub.log
npm run hub:status       # is it running, and does it start at login?
npm run hub:restart      # after pulling changes; terminals carry on
npm run hub:stop         # stops the hub and ends any terminals
npm run hub:login        # start it at login (Windows); undo with npm run hub:login-off
```

Then open `http://127.0.0.1:4711`. It's one page (decision 31): the island fills the window, the board runs down the left, and a session's story opens on the right.

**As an app** (decision 43). `npm run app` opens Mira in a window of its own instead of a browser tab, starting the hub in the background first if it isn't running; closing the window leaves the hub running. Right-click its taskbar button and choose "Pin to taskbar", and the pinned button opens it straight away, under Mira's name and icon. Only Mira's page shows in it: web links open in your browser, and VS Code links in VS Code. F5 reloads, F11 is full screen, F12 opens the developer tools, and Ctrl with plus, minus or 0 zooms. While a prompt waits for you, its taskbar button flashes. It keeps its size and place between runs, and needs Node 24 on the PATH to start the hub. Its icon and the page's favicon are a mirling, drawn from its pixel map in [web/sky/mirling.ts](web/sky/mirling.ts) by `npm run icons`.

- **The island** has a section per project, in the order projects first appeared, with streams between neighbouring sections, bridges where their gates meet, and waterfalls off the front edge (decision 42), and a mirling per session (decision 28). Mirlings act out what their session is doing (decision 41): they read with a book at the library, hammer at the workshop for edits, work a console there for other commands, and walk about with a thought bubble between tools. When it's your turn they play on the swings, down the slide or on a rubber ring in the pond, with a speech bubble. They raise a beacon when they need you, smoke when they fail, and go home when they end. Helpers follow them while subagents run. Each project's workshop grows with its commits in the last 30 days, and its library with the commits that changed docs; new commits float up from the workshop, and pointing at a building shows its count (decision 35). Drag to move; scroll or use the buttons to zoom.
- **Build mode.** "Build" at the bottom right opens a palette where the story would be. Pick a plant, a decoration, path or grass, then click tiles on a project's own ground, inside its shore; Move picks up a building and puts it on a free tile of its section, Restyle gives a house the next style, and Remove takes away a plant, a decoration or a tree. Buildings that stand for real work are never added or removed. Each change is kept by the hub as it's made and shows in every open page; Undo takes changes back, and Done or Escape leaves (decision 39).
- **The board down the left** starts with prompts waiting for an answer, then lists every project, busiest first, with its sessions: status, last tool, how long ago and estimated cost, plus each project's recent commits. Click a session to fly to its mirling and open its story; click a project's name to fly to its section, and a section's name on the island to find the project on the left. Under each project, "Earlier conversations" unfolds the ones Claude Code still keeps, newest first, with their dates and costs; open one to read its story, and carry it on with Terminal or Continue in VS Code (decision 40). "☰ Sessions" folds it away for more island, and it starts folded on narrow screens.
- **Prompts.** While the page is open and on screen with "Answer prompts here" ticked, permission prompts wait for up to 60 seconds before the terminal asks. Answer them on the left or in the story. "Needs you" flies to the next mirling waiting.
- **Starting a session.** "+ New" on a project opens a new Claude Code chat in its VS Code window, with a prompt you type in Mira already in the box; you send it from VS Code (decision 29).
- **Renaming and removing.** A project's ⋯ menu has Rename and Remove, each session has ✎ on hover to rename it, and the story has Rename and Remove for its session. A session's name is saved where Claude Code keeps it, so VS Code and `claude --resume` show it too, and a session renamed in VS Code shows its new name here within a few seconds (decision 37). Project names and removals are kept in `mira.db`; a removed project or session comes back once something happens in it again, and ended sessions leave on their own after five minutes (decision 30).

**The story** shows every turn with its prompt, replies and tool calls, the subagents it started, and tokens and estimated cost for each turn and the whole session. Replies are rendered from Markdown by [web/markdown.js](web/markdown.js), which escapes all text first, so HTML in a reply shows as text; links open only for http(s), and links to repo files show as their names. The latest turn starts unfolded and the story follows the session live, and closing it zooms back out to the whole island, centred. "Continue in VS Code" at the top opens the conversation in Claude Code's chat panel, in the VS Code window whose workspace holds the session's folder, or in a new window on that folder. "Terminal" switches the story to a terminal running `claude --resume` in the session's folder, so you can carry the conversation on right there (decision 36). It keeps running if you close the story, and picks up where it was when you open it again: clicking a session whose terminal is running, on the left or on the island, opens straight onto the terminal. Stop ends it. Escape inside the terminal goes to Claude Code, not the page. It looks like my Windows Terminal: Cascadia Code, semi-light, 8 point, with cells 1.2 times the font size high and 0.6 wide. A− and A+ change the text size a point at a time, remembered in that browser. If the session is open in VS Code or another terminal, close it there first. Terminals run in the terminal host, a process of their own (decision 38), so restarting the hub, or the hub crashing, leaves them running: the page says it's reconnecting and carries on where it was a moment later. `npm run hub:stop` ends them, and the host ends itself once nothing has run in it for a minute. It logs to `~/.mira/terminals.log`. A link to the page with `#session=<id>` opens that session's story. Titles and stories are read from the transcripts when needed, and never stored.

On startup it rebuilds today's picture from stored events, reads recent Claude Code transcripts to find sessions that ran while it was stopped, and stores the token counts of turns that ended in the last day. Everything it keeps is in `~/.mira`:

| Path | What |
|---|---|
| `mira.db` | Events for 90 days, and every per-turn usage event, in SQLite (decisions 17, 23 and 32) |
| `recordings/` | Payload shapes, as the step 0 recorder wrote them, while `recordShapes` is on |
| `config.json` | Optional settings, below |
| `hub.log`, `hub.pid` | The log and process ID of a hub running in the background |

## Settings

`~/.mira/config.json` is optional. Every field has a default:

```json
{
  "port": 4711,
  "systems": { "acme-core": "Acme", "acme-web": "Acme" },
  "permissionWaitSeconds": 60,
  "activeHours": 2,
  "recordShapes": true,
  "keepDays": 90,
  "quiet": { "workingMinutes": 60, "idleHours": 12 },
  "prices": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2 } }
}
```

- `systems` renames or groups sections by folder, before anything reaches the store; Rename in Mira only changes the name shown (decision 30). Keys are repo folder names; giving two folders the same name puts them in one section. Git worktrees join their main repo's section on their own, labelled with the worktree's folder name, so they need no entry here.
- `permissionWaitSeconds` is how long a prompt waits for Mira while Mira is open. Keep it below the `PermissionRequest` hook's timeout, which is 65 seconds.
- `activeHours` is how recent a transcript must be for its session to count as running at startup.
- `keepDays` is how many days of events to keep; 0 keeps everything. Per-turn token counts are always kept (decision 32).
- `quiet` is how long a session with no events stays in view: one still working, and any other. One waiting on a prompt always stays (decision 33).
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
| `GET /` | The page: the island, the board down its left and the story (also at `/sky`) |
| `GET /shared/…`, `/sky/…` | The browser modules (TypeScript, sent with types stripped) and styles, plus `/markdown.js` and `/vendor/phaser.js` |
| `GET /api/systems` | Projects active in the last 14 days, in the order each first appeared, with my name for each if I gave one |
| `PUT /api/names/system/:name`, `/api/names/session/:id` | `{ "name" }`, up to 80 characters: my name for a project, where empty goes back to its own, or a new name for a session, saved with its source |
| `POST /api/remove/system/:name`, `/api/remove/session/:id` | Removes a project (with its sessions) or a session from view until something happens in it again |
| `POST /ingest/<source>` | Events from a source, for example `/ingest/claude-code` for the hook commands |
| `POST /hooks/permission` | Claude Code permission prompts, held for an answer while Mira is open |
| `GET /api/sessions` | Live sessions and prompts waiting for an answer |
| `GET /api/sessions/:id/terminal` | Whether a session can have a terminal, and whether one is running. A WebSocket at the same address carries it: output down, keystrokes and size up. |
| `GET /api/sessions/:id/story` | A session's story, read on demand. `?turns=30` sets how many recent turns; `?helper=<agent id>` tells one subagent's story instead. |
| `GET /api/sessions/:id/editor` | The VS Code window to continue a session in: `{ link, name }`, where `link` brings that window forward |
| `POST /api/sessions/:id/editor` | Opens the session in that window's Claude Code chat, a moment later |
| `GET /api/layouts` | How each project's section is arranged in build mode, by project (decision 39) |
| `PUT /api/layouts/:system` | A project's layout: `{ ground, placed, removed, moved, styles }`, places on its own ground from `1,1` to `8,8`; an empty one forgets it |
| `GET /api/systems/:name/history` | The project's earlier conversations, newest first, leaving out those on the board: `{ sessions: [{ id, title, lastAt, cwd, usage }], more }`. `?limit=20` and `?before=<lastAt>` page through them. Read from the sources when asked (decision 40). |
| `GET /api/systems/:name/start` | The project's folder and its VS Code window: `{ link, name, folder }` |
| `POST /api/systems/:name/start` | `{ "prompt" }`: opens a new Claude Code chat in that window, a moment later, with the prompt typed in. Up to 1,500 characters. |
| `GET /api/events?limit=100` | The most recent events |
| `GET /api/stream` | Live updates as Server-Sent Events. Add `?visible=0` for a viewer that isn't on screen. |
| `POST /api/presence` | `{ "viewer", "visible" }`: whether a viewer is on screen |
| `POST /api/prompts/:id` | `{ "decision": "allow" }`, `"deny"`, or `"terminal"` to hand the prompt back to the terminal at once |

## Adding a source

Each source is an adapter (decision 22), defined in [src/sources.ts](src/sources.ts). Every piece is optional: `ingest` turns what the source posts to `/ingest/<id>` into an event, `discover` finds its sessions at startup, `catchUp` fills in what was missed while the hub was stopped, `followUp` adds events that follow from one just recorded, `title` names a session, and `story` tells it for the panel. Claude Code's adapter is [src/claude-code/source.ts](src/claude-code/source.ts). To add an agent, write its adapter, add it to the list in [src/main.ts](src/main.ts), and point the agent's hooks at `/ingest/<id>`.

## The browser side

[web/index.html](web/index.html) is the page. The live connection, the story panel, dialogs and styles are in [web/shared/](web/shared/), and the board down the left is [web/sky/sidebar.ts](web/sky/sidebar.ts). The sky's code is in [web/sky/](web/sky/): the island layout (`world.ts`), the scene (`scene.ts`) and the art. Browser code is TypeScript, which the hub sends with its types stripped (decision 26), so there's still no build step; `npm run typecheck` checks it against the DOM and Phaser's types.

**Swapping in an art pack (decision 25).** Every picture the sky uses has a name in [web/sky/art.ts](web/sky/art.ts), and [web/sky/drawn-art.ts](web/sky/drawn-art.ts) draws them all in code. A pack replaces it with one module that implements the same `Art` interface: load the pack's atlas in `preload`, register its frames under the same names in `create`, give buildings their anchors, and pass it to the scene in [web/sky/main.ts](web/sky/main.ts).

## Safety

- It listens on `127.0.0.1` only. It refuses requests that carry another site's `Origin`, a browser's mark that they came from another site (`Sec-Fetch-Site`), or a different `Host`, so a web page can't inject events, answer a prompt or read a story.
- It stores events, never content: no prompts, tool input or output, or messages. The command a permission prompt shows is held in memory while it waits, and never stored.
- Stories are read from transcripts when asked for, and only from files under `~/.claude/projects`, whatever path a hook payload names.
- Renaming a Claude Code session is the one write into Claude Code's files: one `custom-title` line appended to that session's own transcript, which must be under `~/.claude/projects` and named by its UUID, and its `custom-title.json`, exactly as Claude Code writes them.
- A terminal runs only the source's own resume command, for a session the hub knows, with an ID that must be a UUID; its WebSocket takes the same this-machine-only checks as every other request. The hub passes on only what a page may say about its terminal (keystrokes, its size, start and stop). The terminal host listens on a local pipe and drops any connection that doesn't open with its secret, which it keeps in `~/.mira/terminals.json`. What's typed into it is passed straight to the program.
- The only things the hub opens on the desktop are Claude Code's own links: a session it already knows, by an ID that must be a UUID, or a new chat in a project folder it found from its own records, with my prompt typed in but not sent (decision 29). Which workspace holds which folder is read from VS Code's record of its open windows (`Code/User/globalStorage/storage.json`) and the workspace files it names, and never written.

**Continuing in VS Code, the first time.** The browser asks whether Mira may open VS Code; tick "Always allow". VS Code then asks whether to open the workspace from an outside link; tick "Allow opening local paths without asking". Until both are ticked, the conversation may open in whichever VS Code window was used last; clicking again puts it right.
