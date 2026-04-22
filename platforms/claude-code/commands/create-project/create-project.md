---
name: create-project
description: Create a new Syntaur project with full scaffolding
arguments:
  - name: args
    description: "Title and optional flags (--slug, --dir, --workspace). See the create-project skill for full usage."
    required: false
---

# /create-project

Thin wrapper that invokes the `create-project` skill. The skill lives in `~/.claude/skills/create-project/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — calling `syntaur create-project`, reading the generated project.md, and guiding next steps.

## Instructions

Invoke the `create-project` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
