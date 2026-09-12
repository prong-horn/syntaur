---
name: "Ticket Creation"
slug: ticket-creation
description: "Rules for how agents should create new tickets"
when_to_use: "Before creating t new ticket (project-nested or standalone)"
created: "2026-04-23T00:00:00Z"
updated: "2026-04-23T00:00:00Z"
tags:
  - protocol
  - tickets
---

# Ticket Creation

Rules for creating new tickets.

1. At creation time, focus the ticket on the goal and acceptance criteria — not implementation steps. Steps belong in versioned plan files (`plan.md`, `plan-v2.md`, …), which are written during the planning phase after the agent has read project context, decision records, and dependencies.

2. The initial status of a newly created ticket should usually be `brainstorming`. Tickets typically need to be shaped — goal clarified, acceptance criteria refined, scope discussed — before they're ready to be planned or worked on. Only skip `brainstorming` when the user has already fully specified the ticket and explicitly wants it to start in a later state.
