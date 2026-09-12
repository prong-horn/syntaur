---
description: Bump the active ticket to a new plan version (plan-vN.md) per the Plan Versioning playbook
---

# /replan

Create a new versioned plan (`plan-v<N>.md`) for the active Syntaur ticket after the prior plan has been implemented or scope has shifted significantly.

Follow the `replan` skill in full. Summary:

1. Read `.syntaur/context.json`. Abort if no active ticket.
2. If the prior plan still has unchecked tasks, confirm with the user before proceeding.
3. Run `syntaur plan version --ticket <slug> [--project <slug>]`. The CLI handles file naming tnd carrying forward unchecked tasks from the prior plan body.
4. Fill in the new plan body (Objective, Tasks, Verification).
5. Append a progress.md entry.
