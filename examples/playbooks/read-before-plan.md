---
name: "Read Before You Plan"
slug: read-before-plan
description: "Agents must read all mission context files before creating or modifying a plan"
when_to_use: "Before creating or modifying plan.md"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - protocol
  - planning
---

# Read Before You Plan

Before creating or modifying plan.md, read these files in order:

1. `manifest.md` -- understand the mission structure
2. `mission.md` -- understand the goal and scope
3. `agent.md` -- understand conventions and constraints
4. `claude.md` (if exists) -- Claude-specific instructions
5. `assignment.md` -- understand your specific task, acceptance criteria, and dependencies
6. `handoff.md` (if exists) -- understand what previous agents did and learned
7. `decision-record.md` (if exists) -- understand past decisions and their rationale

Do NOT skip files because you think you know what's in them. Context from prior agents is often critical.

If the assignment has `dependsOn` entries, read those assignments too -- understand what they produced and any interfaces you need to conform to.
