---
name: plan-assignment
description: Create a detailed implementation plan for the current Syntaur assignment
arguments:
  - name: args
    description: "Optional — see the plan-assignment skill for supported flags"
    required: false
---

# /plan-assignment

Thin wrapper that invokes the `plan-assignment` skill. The skill lives in `~/.claude/skills/plan-assignment/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — picking the next `plan-v<N>.md`, writing it, appending a `## Todos` entry, marking any prior plan todo superseded, and recording key decisions in `decision-record.md`.

## Instructions

Invoke the `plan-assignment` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
