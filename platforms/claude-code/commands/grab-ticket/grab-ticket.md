---
name: grab-ticket
description: Claim a Syntaur ticket and load it into the current working context
arguments:
  - name: args
    description: "Project slug and optional ticket slug, or --id <uuid> for standalone. See the grab-ticket skill for full forms."
    required: false
---

# /grab-ticket

Thin wrapper that invokes the `grab-ticket` skill. The skill lives in `~/.claude/skills/grab-ticket/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — discovering pending tickets, merging `.syntaur/context.json`, registering the agent session, reading the ticket.

## Instructions

Invoke the `grab-ticket` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
