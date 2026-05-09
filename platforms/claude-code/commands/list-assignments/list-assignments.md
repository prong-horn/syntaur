---
name: list-assignments
description: List Syntaur assignments across projects with filters by status, project, tag, age (scriptable; not the interactive browse TUI)
arguments:
  - name: args
    description: "[--status <list>] [--project <slug>] [--tag <list>] [--age <duration>] [--json]"
    required: false
---

# /list-assignments

Thin wrapper that invokes the `list-assignments` skill via the Skill tool. The skill maps user prose to `syntaur ls` flags and presents the table or JSON output.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
