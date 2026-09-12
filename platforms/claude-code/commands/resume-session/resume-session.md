---
name: resume-session
description: Re-orient a fresh Claude Code session on the active Syntaur ticket without re-reading the full transcript
arguments:
  - name: args
    description: "No arguments. Reads .syntaur/context.json and any open handoff.md."
    required: false
---

# /resume-session

Thin wrapper that invokes the `resume-session` skill via the Skill tool. The skill calls `syntaur session resume`, reads any open handoff, and reports the active context. Idempotent.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
