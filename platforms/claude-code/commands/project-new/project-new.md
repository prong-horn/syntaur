---
name: project-new
description: Create a new Syntaur project with full scaffolding
arguments:
  - name: args
    description: "Title and optional flags (--slug, --prefix, --dir). See the project-new skill for full usage."
    required: false
---

# /project-new

Thin wrapper that invokes the `project-new` skill. The skill lives in `~/.claude/skills/project-new/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — calling `syntaur project new`, reading the generated project.md, and guiding next steps.

## Instructions

Invoke the `project-new` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
