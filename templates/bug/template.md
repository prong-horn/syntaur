---
id: bug
version: 1
builtin: bug@2
description: Bug fix flow with optional plan, required review, and workspace.
whenToUse: Defect fixes where plan is optional but review and workspace are required.
workspace: required
defaultPriority: high
stages:
  - id: backlog
    instructions: Triage the bug. Optionally run syntaur plan to capture a fix plan before start.
  - id: in_progress
    instructions: Fix the defect. Log progress. Tick acceptance criteria as verified.
    agent: cursor
    auto: true
  - id: review
    instructions: Verify fix and regression tests. Log review verdict.
    reviewer: cursor
    auto: false
  - id: done
    instructions: Terminal.
files:
  - path: plan.md
    role: plan
    writer: agent
    createOn: never
    description: Optional fix plan; created only when syntaur plan is run.
  - path: journal.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: Work log for the bug fix.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
gates:
  start: [workspace-set]
  done: [criteria-checked, handoff-logged, review-clean, deps-done]
---

Built-in template; copy the directory to customise
