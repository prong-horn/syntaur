---
name: set-workspace
description: Populate the four workspace.* fields in the active assignment.md per the Workspace Before Code playbook (validates via doctor first)
arguments:
  - name: args
    description: "[--repository <path>] [--worktree-path <path>] [--branch <name>] [--parent-branch <name>] — auto-detects defaults from git when omitted"
    required: false
---

# /set-workspace

Thin wrapper that invokes the `set-workspace` skill via the Skill tool. The skill validates the assignment.md via `syntaur doctor --assignment <path> --json` first; refuses to write on errors. Auto-detects `repository` and `branch` from `git rev-parse` when not supplied.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
