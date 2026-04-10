---
name: create-mission
description: Use when the user wants to create a new Syntaur mission and scaffold its mission.md, agent.md, claude.md, indexes, and manifest files.
---

# Create Mission

Create a new Syntaur mission from Codex.

## Arguments

User arguments: `$ARGUMENTS`

Parse:

- First positional argument: mission title
- `--slug <slug>` optional
- `--dir <path>` optional
- `--workspace <workspace>` optional: workspace grouping label (e.g., `syntaur`, `reeva`)

If no title was provided, ask the user for it.

## Workflow

1. Run `syntaur create-mission "<title>" [--slug <slug>] [--dir <path>] [--workspace <workspace>]`.
2. If the command fails, report the error and stop.
3. Read the generated `mission.md` to confirm the mission path and scaffold.
4. Summarize:
   - mission slug
   - mission directory
   - key files created: `manifest.md`, `mission.md`, `agent.md`, `claude.md`
5. Suggest next steps:
   - fill in `mission.md`
   - add mission-wide guidance to `agent.md`
   - run `create-assignment` for the first task
