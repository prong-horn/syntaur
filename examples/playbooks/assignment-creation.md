---
name: "Assignment Creation"
slug: assignment-creation
description: "Rules for how agents should create new assignments"
when_to_use: "Before creating a new assignment (project-nested or standalone)"
created: "2026-04-23T00:00:00Z"
updated: "2026-04-23T00:00:00Z"
tags:
  - protocol
  - assignments
---

# Assignment Creation

Rules for creating new assignments.

1. Do not pre-populate assignments with specific todos unless the user explicitly asks for them. Todos belong to the planning phase, and baking them into the assignment at creation time locks in an approach before the agent has read the project context, decision records, or dependencies. Let the assignment describe the goal and acceptance criteria; let the plan describe the steps.

2. The initial status of a newly created assignment should usually be `brainstorming`. Assignments typically need to be shaped — goal clarified, acceptance criteria refined, scope discussed — before they're ready to be planned or worked on. Only skip `brainstorming` when the user has already fully specified the assignment and explicitly wants it to start in a later state.
