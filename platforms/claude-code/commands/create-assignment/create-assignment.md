---
name: create-assignment
description: Create a new Syntaur assignment (project-nested or standalone one-off)
arguments:
  - name: args
    description: "Title and flags. See the create-assignment skill for supported forms (e.g. --project <slug>, --one-off, --type <type>, --with-todos)."
    required: false
---

# /create-assignment

Thin wrapper that invokes the `create-assignment` skill. The skill lives in `~/.claude/skills/create-assignment/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — picking project-nested or standalone, validating the type, scaffolding assignment.md / progress.md / comments.md.

## Instructions

Invoke the `create-assignment` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
