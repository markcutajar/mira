# Mira

**A little island where your Claude Code sessions live.**

*Mira* is Maltese for "aim", and the name of a star in Cetus (Latin for "wonderful").

Mira watches every Claude Code session on your machine and draws them as mirlings, small creatures at work on a pixel-art island floating in space. Each project is a section of the island. At a glance you see what's moving, what's stuck and what's waiting on you; click a mirling and its story opens, turn by turn, with tokens and estimated cost.

> **Status:** a personal project, built and used on Windows 11. It runs on Linux too, tested on Ubuntu 22.04, and should run on a Mac, though nobody has tried yet. Starting the hub at login is only set up for Windows so far.

## What it does

- **The island.** A section per project, joined by streams and bridges, and a mirling per session acting out what it's doing: reading at the library, hammering at the workshop, thinking between tools, and playing on the swings or floating in the pond while it's your turn. Workshops and libraries grow with each project's commits over the last 30 days.
- **The story.** Every turn of a session, with its replies, tool calls and subagents, and tokens and estimated cost per turn, read from Claude Code's transcripts when you open it.
- **Stepping in.** Answer permission prompts from Mira, send a running session a message, start a new session in VS Code with your prompt typed in, carry a session on in a terminal inside the page, or open it in VS Code.
- **Notifications** when a session needs you, fails, or finishes a long turn.
- **Build mode** to make the island yours: plants, decorations, paths, ponds, boats, swings, slides and trampolines.
- **Project groups**, so related repos share one section.
- **A desktop app**: a window of its own to pin to the taskbar.

## How it works

Claude Code's hooks send each event to a small hub on your machine, at `http://127.0.0.1:4711`, which keeps the live picture of every session and serves the page. Your sessions never depend on Mira: the hooks that report run in the background and fail silently, and a permission prompt only waits for Mira while Mira is open, so everything behaves the same whether Mira is running or not. Mira stores events and token counts, never your prompts, replies or files; a story is read from its transcript when you open it.

## Getting started

You need Node 24 or later, and Claude Code.

```bash
npm install
npm start        # the hub, at http://127.0.0.1:4711
npm run app      # optional: Mira in a window of its own
```

Then add Mira's hooks to your Claude Code user settings, `~/.claude/settings.json`, so every repo reports without committing anything. [hub/README.md](hub/README.md) has the hooks, the settings in `~/.mira/config.json`, running the hub in the background, and the rest of what the hub does. The event contract is in [contracts/](contracts/README.md).

## Other agents

Mira knows Claude Code. Every source plugs into the hub through one adapter, so another agent can be added by writing its adapter: see "Adding a source" in [hub/README.md](hub/README.md).

## Inspirations

Thronglets (Black Mirror, "Plaything") for a little world that lives on its own, Pixel Agents for characters whose animation shows what they're really doing, Satisfactory for work that piles up, and Minions for many small, eager workers.

These projects were read as reference while building Mira, and are all MIT-licensed: [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents), [Mission Control](https://github.com/builderz-labs/mission-control) and [Agent Mission Control](https://github.com/danwahlin/agent-mission-control).
