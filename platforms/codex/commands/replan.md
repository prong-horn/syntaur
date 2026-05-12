---
description: Bump the active assignment to a new plan version (plan-vN.md) per the Plan Versioning playbook
---

# /replan

Create a new versioned plan (`plan-v<N>.md`) for the active Syntaur assignment after the prior plan has been implemented or scope has shifted significantly.

Follow the `replan` skill in full. Summary:

1. Read `.syntaur/context.json`. Abort if no active assignment.
2. If the prior plan still has unchecked tasks, confirm with the user before proceeding.
3. Run `syntaur plan version --assignment <slug> [--project <slug>]`. The CLI handles file naming, supersede-rewrite of `assignment.md` `## Todos`, and carrying forward unchecked todos.
4. Fill in the new plan body (Objective, Tasks, Verification).
5. Append a progress.md entry.
