---
name: plan-assignment
description: Use when the user wants a detailed implementation plan written to plan.md for the current Syntaur assignment.
---

# Plan Assignment

Create an implementation plan for the current Syntaur assignment.

## Arguments

Optional notes from the user: `$ARGUMENTS`

## Workflow

1. Read `.syntaur/context.json` from the current working directory. If it does not exist, tell the user to claim an assignment first.
2. Read:
   - `<assignmentDir>/assignment.md`
   - `<missionDir>/agent.md`
   - `<missionDir>/claude.md` if it exists
   - `<missionDir>/mission.md`
3. If the assignment depends on other assignments, read each dependency handoff for integration context.
4. Explore `workspaceRoot` when it exists:
   - inspect project structure
   - find likely implementation files
   - note conventions and architecture
5. Update `<assignmentDir>/plan.md`:
   - preserve the existing YAML frontmatter
   - set `status` to `in_progress` if it is still `draft`
   - refresh the `updated` timestamp
   - replace the body with a concrete plan

## Plan Contents

Write these sections:

1. Overview
2. Tasks
3. Acceptance Criteria Mapping
4. Risks and Open Questions
5. Testing Strategy

## Reporting

After writing the plan:

- summarize the number of tasks and key decisions
- call out open questions or risks
- remind yourself to keep `assignment.md` progress and acceptance criteria current during implementation
