---
description: Create a repo-local worktree for the active Syntaur ticket and bind the session to it
---

# /syntaur-worktree

Atomic worktree-and-grab. Composes `syntaur worktree create` + `syntaur assign` + `syntaur start` + writing `.syntaur/context.json` in the new workspace. Worktree path is always `<repository>/.worktrees/<branch>`.

Follow the `syntaur-worktree` skill in full. Summary:

1. Resolve `--project --ticket --branch [--repository --parent-branch]`.
2. Run `syntaur worktree create ...` (atomic: rolls back on ticket.md write failure).
3. Run `syntaur assign <ticket> --agent <name>` then `syntaur start <ticket>` (only when status was pending).
4. `cd` into the new worktree path, write `.syntaur/context.json`.
5. Run `syntaur track-session` to register with the dashboard.
