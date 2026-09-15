---
id: feature
version: 1
builtin: feature@2
description: Full development cycle with plan approval, workspace, implementation, and review.
whenToUse: Default for feature work, refactors, and multi-step implementation with plan and review gates.
workspace: required
defaultPriority: medium
playbooks:                   # documentary; content lives in stages[].instructions
  - create-and-plan-assignment
  - plan-versioning
  - read-before-plan
  - workspace-before-code
  - keep-records-updated
  - e2e-dev-cycle
stages:
  - id: backlog
    label: Backlog
    instructions: Ticket is queued. Run syntaur plan create <ID> when ready to write the plan.
  - id: planning
    label: Planning
    instructions: |
      Read before you plan, in order: project.md, ticket.md, this ticket's journal.md, then every depends_on ticket's plan and its decision entries (syntaur show <dep> --log -t decision). Upstream decisions are binding; do not contradict them silently. Do not skip files you think you already know.
      Write plan.md: objective, decisions, tasks with files and tests, verify steps, risks. Iterate on plan.md directly until an independent review has no high or medium findings and you agree it is solid; never version an unimplemented plan.
      Record accepted decisions with syntaur log <ID> -t decision. Ask through syntaur log <ID> -t question when a choice is the human's; answer open questions with -t answer --answers <ts>.
    agent: claude
    auto: false
  - id: ready
    label: Ready
    instructions: |
      Plan approved. Before any implementation code, bind a workspace: syntaur worktree create --branch <name> (or syntaur workspace set with repository, branch, worktree and parentBranch); syntaur start refuses without it.
      Run syntaur start <ID> when the workspace is set.
  - id: in_progress
    label: In Progress
    instructions: |
      Implement the approved plan task by task; keep the plan's task checkboxes current. After every meaningful step run syntaur log <ID> -t progress; tick acceptance criteria in ticket.md the moment each is met, never in a batch. journal.md is append-only through syntaur log; never edit it directly.
      Commit in small logical units with clear messages tied to plan tasks; run the linter or formatter before committing when the project has one; never amend; never commit secrets.
      If the plan must change mid-flight, add a "Revision N" section to plan.md (reason, what changed, what was already done) and log a decision; after implementation, change course with syntaur plan version <ID> and leave the implemented plan intact.
      Stopping before done: log a progress entry with the current state and what comes next. Questions for the human go through syntaur log <ID> -t question.
    agent: cursor
    auto: true
  - id: review
    label: Review
    instructions: |
      Verify every acceptance criterion with evidence: run the test suite and the build, check for regressions, and say what you could not verify.
      Have the work reviewed; fix every high and medium finding and re-review until the reviewer has none and you agree the code is solid. Then syntaur log <ID> -t review --verdict approve --open high=0,medium=0.
      Hand off with syntaur log <ID> -t handoff (summary, state, next steps, context the next agent needs), then syntaur done <ID>.
    reviewer: cursor
    auto: false
  - id: done
    label: Done
    instructions: Terminal. Criteria checked, handoff logged and a clean review are required before syntaur done.
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
  start: [plan-approved, workspace-set]
  done: [criteria-checked, handoff-logged, review-clean, deps-done]
---

Built-in template; copy the directory to customise
