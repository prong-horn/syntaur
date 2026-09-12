---
name: "Ticket Planning"
slug: ticket-planning
description: "Rules for how agents should version plan files when planning"
when_to_use: "When creating t plan for an ticket, or creating t new plan after a prior one has been executed"
created: "2026-04-23T00:00:00Z"
updated: "2026-04-23T00:00:00Z"
tags:
  - protocol
  - planning
  - tickets
---

# Ticket Planning

Rules for versioned plan files during planning.

1. When planning tn ticket for the first time, write `plan.md` under the ticket directory (via `syntaur plan create` or the `plan-ticket` skill).

2. If asked to create a new plan after a prior plan has been implemented, write the next versioned file (`plan-v2.md`, `plan-v3.md`, …) via `syntaur plan version` or the `replan` skill.

   Leave prior plan files intact on disk — the history of plan cycles is part of the ticket record.
