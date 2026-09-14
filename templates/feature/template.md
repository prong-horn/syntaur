---
id: feature
version: 1
builtin: feature@1
description: Full development cycle with plan approval, workspace, implementation, and review.
whenToUse: Default for feature work, refactors, and multi-step implementation with plan and review gates.
workspace: required
defaultPriority: medium
playbooks:
  - create-and-plan-assignment
  - plan-versioning
  - read-before-plan
  - workspace-before-code
  - keep-records-updated
stages:
  - id: backlog
    label: Backlog
    instructions: Ticket is queued. Run syntaur plan when ready to write the plan.
  - id: planning
    label: Planning
    instructions: |
      Read all project context before planning: project.md, ticket.md, upstream tickets' decision logs, and dependencies.
      Write plan.md with objective, tasks, and verify steps. Iterate until review-ready.
      Do not skip context files you think you already know.
  - id: ready
    label: Ready
    instructions: |
      Plan is approved. Set workspace fields (repository, branch, worktree, parentBranch) in ticket.md before any implementation code.
      Run syntaur start when the workspace is set and dependencies are done.
  - id: in_progress
    label: In Progress
    instructions: |
      Implement the approved plan task by task. Log progress after meaningful steps.
      Tick acceptance criteria in ticket.md as each is met. Commit in small logical units with clear messages.
      Never commit secrets. Run linter before commit if configured.
    agent: cursor
    auto: true
  - id: review
    label: Review
    instructions: |
      Verify every acceptance criterion with evidence. Run the test suite and build.
      Log a review entry with verdict and open issue counts. Fix high/medium findings before approve verdict.
    reviewer: pi
    auto: false
  - id: done
    label: Done
    instructions: Terminal. Deliverable and handoff requirements must be satisfied before syntaur done.
files:
  - path: plan.md
    role: plan
    writer: agent
    createOn: planning
    description: Implementation plan with tasks and verify steps; requires human approval before start.
  - path: journal.md
    role: log
    writer: cli
    createOn: ticket-creation
    description: Append-only log for progress, decisions, handoffs, questions, answers, and reviews.
    entryTypes: [progress, decision, handoff, note, question, answer, review]
gates:
  approve: [plan-exists]
  start: [plan-approved, deps-done, workspace-set]
  done: [criteria-checked, handoff-logged, review-clean]
---

Built-in template; copy the directory to customise
