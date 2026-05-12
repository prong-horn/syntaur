---
name: syntaur-worktree
description: Create a repo-local worktree for the active Syntaur assignment and bind the session to it (atomic create + grab)
arguments:
  - name: args
    description: "--branch <name> [--repository <path>] [--parent-branch <name>] [--project <slug>] [--assignment <slug>]"
    required: false
---

# /syntaur-worktree

Thin wrapper that invokes the `syntaur-worktree` skill via the Skill tool. The skill composes `syntaur worktree create` + `syntaur assign` + `syntaur start` + writes `.syntaur/context.json`. Worktree path is always `<repository>/.worktrees/<branch>`.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
