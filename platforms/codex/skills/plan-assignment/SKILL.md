---
name: plan-assignment
description: Use when the user wants a detailed implementation plan written as a versioned plan file for the current Syntaur assignment.
---

# Plan Assignment

Create an implementation plan for the current Syntaur assignment. Plans are versioned files: the first is `plan.md`, later ones are `plan-v2.md`, `plan-v3.md`, etc. Each plan gets a linked entry in the `## Todos` section of `assignment.md`, and any prior active plan todo is marked superseded.

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
5. Determine the next plan filename:
   - List `<assignmentDir>/plan*.md`.
   - If none exist, target is `plan.md` (version label: "plan").
   - Otherwise pick the smallest `N >= 2` such that `plan-v<N>.md` does not exist (version label: `plan v<N>`).
6. Write `<assignmentDir>/<planFilename>` with standard plan frontmatter (`assignment`, `status: draft`, `created`, `updated`) and a body containing the sections below. If the file already exists (only possible for `plan.md` on first re-run), preserve frontmatter, flip `status` from `draft` to `in_progress`, update `updated`, and replace only the body.
7. Update `<assignmentDir>/assignment.md`:
   - Find unchecked todos matching `- [ ] Execute [<label>](./plan*.md)`. Rewrite each as `- [x] ~~Execute [<label>](./<old-filename>)~~ (superseded by <versionLabel>)`. Never delete the old line.
   - Append a new todo: `- [ ] Execute [<versionLabel>](./<planFilename>)`.
   - If `## Todos` is missing (legacy assignment), insert it right after `## Acceptance Criteria` with a short guidance comment and the new todo line.
   - Refresh the assignment frontmatter `updated` timestamp.

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
- note which plan filename was written and which prior plan (if any) was superseded
- remind yourself to keep `assignment.md` progress, acceptance criteria, and todos current during implementation
