---
name: replan
description: Bump the active Syntaur assignment to a new plan version (plan-vN.md) per the Plan Versioning playbook
arguments:
  - name: args
    description: "Optional --assignment <slug> --project <slug>. Defaults to active assignment."
    required: false
---

# /replan

Thin wrapper that invokes the `replan` skill via the Skill tool. The skill drives `syntaur plan version` (deterministic file ops) and writes the new plan body.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
