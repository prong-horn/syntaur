---
name: create-ticket
description: Create a new Syntaur ticket (project-nested or scratch default)
arguments:
  - name: args
    description: "Title and flags. See the create-ticket skill for supported forms (e.g. --project <slug>, --type <type>)."
    required: false
---

# /create-ticket

Thin wrapper that invokes the `create-ticket` skill. The skill lives in `~/.claude/skills/create-ticket/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — picking a project or scratch default, validating the template, and scaffolding template-owned files.

## Instructions

Invoke the `create-ticket` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
