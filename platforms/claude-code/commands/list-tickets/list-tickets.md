---
name: list-tickets
description: List Syntaur tickets across projects with filters by status, project, tag, age (scriptable output)
arguments:
  - name: args
    description: "[--status <list>] [--project <slug>] [--tag <list>] [--age <duration>] [--json]"
    required: false
---

# /list-tickets

Thin wrapper that invokes the `list-tickets` skill via the Skill tool. The skill maps user prose to `syntaur ls` flags and presents the table or JSON output.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
