---
name: complete-ticket
description: Append a progress entry + handoff and transition the current Syntaur ticket to review or done
arguments:
  - name: args
    description: "Optional — see the complete-ticket skill for supported flags"
    required: false
---

# /complete-ticket

Thin wrapper that invokes the `complete-ticket` skill. The skill lives in `~/.claude/skills/complete-ticket/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — verifying acceptance criteria, appending a progress.md entry, writing a handoff.md section, and calling `syntaur review` or `syntaur done`.

## Instructions

Invoke the `complete-ticket` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
