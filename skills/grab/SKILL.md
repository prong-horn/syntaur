---
name: grab
description: >-
  Claim a Syntaur ticket and bind the workspace. Use when the user wants to grab,
  claim, or start work on a ticket, set workspace paths, or run /grab.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Grab

Run `syntaur show <ID>` and follow **Stage**, **Next**, and **Commands**. All writes go through CLI verbs.

## Pre-flight

Check `syntaur session resume --json`. If an active ticket exists, warn that grabbing rebinds the session unless the user confirms.

## Claim

```bash
syntaur assign <ID> --agent <name> --project <slug>
```

Run `syntaur start <ID> --project <slug>` only when **Next** says start (never rewind `in_progress`, `review`, `done`, or `dropped`). Optional dispatch on start: `--agent <id>`. Use `--by <name>` when audit attribution matters.

For project-nested tickets, add `--project <slug>` on every verb in this skill.

## Workspace

When **Stage** requires a workspace binding:

```bash
syntaur workspace set --ticket <ID> --project <slug> \
  --repository <path> --branch <name> --worktree-path <path> --parent-branch <name>
```

Merge `.syntaur/context.json` (workspace marker only): `repository`, `branch`, `worktree`, `workspaceRoot`, `ticketId`, `ticketDir`, `grabbedAt` (ISO 8601). Preserve `sessionId` / `transcriptPath`. Never write `projectSlug`, `ticketSlug`, `projectDir`, or `title`.

## Session

Register with real session ids only:

```bash
syntaur track-session --project <slug> --ticket <ID> --agent <name> \
  --session-id <id> --transcript-path <path> --path "$(pwd)"
```

Optional: `syntaur statusline install` for Claude Code status display.

Finish by re-running `syntaur show` and following **Stage**.
