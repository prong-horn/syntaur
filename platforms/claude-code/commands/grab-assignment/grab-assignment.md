---
name: grab-assignment
description: Claim a Syntaur assignment and load it into the current working context
arguments:
  - name: args
    description: "Project slug and optional assignment slug, or --id <uuid> for standalone. See the grab-assignment skill for full forms."
    required: false
---

# /grab-assignment

Thin wrapper that invokes the `grab-assignment` skill. The skill lives in `~/.claude/skills/grab-assignment/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — discovering pending assignments, merging `.syntaur/context.json`, registering the agent session, reading the assignment.

## Instructions

Invoke the `grab-assignment` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
