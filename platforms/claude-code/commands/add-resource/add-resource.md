---
name: add-resource
description: Register a project-level resource (link to dashboard, doc, ticket) under a Syntaur project
arguments:
  - name: args
    description: "--project <slug> --name <name> --source <url-or-path> [--category <name>] [--related-assignments <slug,slug>] [--slug <slug>]"
    required: false
---

# /add-resource

Thin wrapper that invokes the `add-resource` skill via the Skill tool. The skill calls `syntaur resource add` and lets the CLI regenerate `_index.md`.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
