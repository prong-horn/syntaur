---
name: complete-assignment
description: Append a progress entry + handoff and transition the current Syntaur assignment to review or completed
arguments:
  - name: args
    description: "Optional — see the complete-assignment skill for supported flags"
    required: false
---

# /complete-assignment

Thin wrapper that invokes the `complete-assignment` skill. The skill lives in `~/.claude/skills/complete-assignment/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — verifying acceptance criteria and todos, appending a progress.md entry, writing a handoff.md section, and calling `syntaur review` or `syntaur complete`.

## Instructions

Invoke the `complete-assignment` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
