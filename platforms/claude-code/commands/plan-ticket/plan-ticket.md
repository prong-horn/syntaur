---
name: plan-ticket
description: Create a detailed implementation plan for the current Syntaur ticket
arguments:
  - name: args
    description: "Optional — see the plan-ticket skill for supported flags"
    required: false
---

# /plan-ticket

Thin wrapper that invokes the `plan-ticket` skill. The skill lives in `~/.claude/skills/plan-ticket/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — picking the next `plan-v<N>.md`, writing it, and recording key decisions in `decision-record.md`.

## Instructions

Invoke the `plan-ticket` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
