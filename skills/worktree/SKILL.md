---
name: worktree
description: >-
  Create a git worktree bound to a Syntaur ticket. Use when branching in
  <repo>/.worktrees/, isolating ticket work, or running /worktree.
license: MIT
metadata:
  author: prong-horn
  version: "3.0.0"
---

# Worktree

Run `syntaur show <ID>` and follow **Stage**, **Next**, and **Commands**. Claiming and `start` belong to **grab**.

## Create

```bash
syntaur worktree create --branch <name> --repository <path> --parent-branch main \
  --ticket <ID> --project <slug>
```

Default path: `<repository>/.worktrees/<branch>` unless `--worktree-path` overrides.

## Marker and session

Merge `.syntaur/context.json` with `repository`, `branch`, `worktree`, `workspaceRoot`, `ticketId`, `ticketDir`, `grabbedAt`; preserve `sessionId` / `transcriptPath`.

```bash
syntaur track-session --project <slug> --ticket <ID> --agent <name> \
  --session-id <id> --path "$(pwd)"
```

`cd` into the worktree. Optional: `syntaur statusline install`.
