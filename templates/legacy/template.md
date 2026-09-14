---
id: legacy
version: 1
builtin: legacy@1
description: v1 assignment layout without file rewriting; maps old record files to roles.
whenToUse: Assigned by migrate v2 to all migrated tickets. Do not use for new tickets.
workspace: optional
defaultPriority: medium
stages:
  - id: backlog
    instructions: Migrated backlog/draft.
  - id: planning
    instructions: Migrated ready_for_planning.
  - id: ready
    instructions: Migrated ready_to_implement.
  - id: in_progress
    instructions: Implementation per approved plan.
  - id: review
    instructions: Review when applicable.
  - id: done
    instructions: Completed.
files:
  - path: progress.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: v1 progress log; append via syntaur log; migrator preserves content.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
  - path: plan.md
    role: plan
    writer: agent
    createOn: ticket-creation
    description: v1 plan file; approval digest in ticket.md plan block.
  - path: scratchpad.md
    role: notes
    writer: agent
    createOn: ticket-creation
    description: v1 scratchpad.
  - path: decision-record.md
    writer: human
    createOn: ticket-creation
    description: v1 decision record; historical read-only after migration.
  - path: handoff.md
    writer: agent
    createOn: ticket-creation
    description: v1 handoff; historical read-only after migration.
  - path: comments.md
    writer: human
    createOn: ticket-creation
    description: v1 comments; historical read-only after migration.
gates:
  approve: [plan-exists]
  start: [deps-done]
  done: [criteria-checked, handoff-logged]
---

Built-in template; copy the directory to customise
