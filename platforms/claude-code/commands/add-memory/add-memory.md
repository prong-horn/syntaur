---
name: add-memory
description: Capture a project-level Syntaur memory under <projectDir>/memories/ via the CLI (distinct from Claude auto-memory)
arguments:
  - name: args
    description: "--project <slug> --name <name> --source <text> [--scope <scope>] [--source-assignment <slug>] [--related-assignments <slug,slug>]"
    required: false
---

# /add-memory

Thin wrapper that invokes the `add-memory` skill via the Skill tool. The skill calls `syntaur memory add` and the CLI regenerates `_index.md` server-side.

Distinct from the user-global Claude Code auto-memory at `~/.claude/projects/<...>/memory/MEMORY.md`. This is project-scoped Syntaur memory.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
