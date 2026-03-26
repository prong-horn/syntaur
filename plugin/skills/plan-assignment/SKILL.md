---
name: plan-assignment
description: Create an implementation plan for the current Syntaur assignment
argument-hint: "[focus area or notes]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# Plan Assignment

Create a detailed implementation plan for your current Syntaur assignment.

## Arguments

Optional notes from the user: $ARGUMENTS

## Step 1: Load Context

Read `.syntaur/context.json` from the current working directory.

If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <mission-slug>` first to claim an assignment."

Extract from the context file:
- `missionSlug` -- the mission slug
- `assignmentSlug` -- the assignment slug
- `assignmentDir` -- absolute path to the assignment folder
- `missionDir` -- absolute path to the mission folder
- `workspaceRoot` -- absolute path to the workspace (may be null)

## Step 2: Read Assignment Details

Read the following files to understand the assignment:

1. Read `<assignmentDir>/assignment.md` -- extract the objective, acceptance criteria, context section, and any Q&A
2. Read `<missionDir>/agent.md` -- extract conventions and boundaries
3. Read `<missionDir>/claude.md` if it exists -- extract Claude-specific instructions
4. Read `<missionDir>/mission.md` -- extract the mission goal for broader context

If the assignment has dependencies (`dependsOn` in frontmatter), read the handoff.md from each dependency's assignment folder for integration context:
- `<missionDir>/assignments/<dep-slug>/handoff.md`

## Step 3: Explore Workspace (if set)

If `workspaceRoot` is not null:

1. Check if the workspace directory exists:
   ```bash
   ls <workspaceRoot>
   ```
2. Explore the codebase structure to understand what exists:
   - Use `Glob` to find key files (e.g., `**/*.ts`, `**/package.json`, `**/*.md`)
   - Use `Grep` to search for relevant patterns mentioned in the assignment
   - Read key files like `package.json`, `tsconfig.json`, or entry points
3. Note any existing patterns, conventions, or architecture you discover

If `workspaceRoot` is null, skip this step and note in the plan that no workspace is configured.

## Step 4: Write the Plan

Read the existing `<assignmentDir>/plan.md` to see its current frontmatter structure. Preserve the YAML frontmatter fields (`assignment`, `status`, `created`, `updated`) and update the `updated` timestamp. Change the `status` field from `draft` to `in_progress` if it is still `draft`.

Replace the markdown body with a detailed implementation plan. The plan should include:

1. **Overview** -- one paragraph summarizing the approach
2. **Tasks** -- numbered list of implementation tasks, each with:
   - Description of what to do
   - Files to create or modify (with paths)
   - Dependencies on other tasks
   - Estimated complexity (low/medium/high)
3. **Acceptance Criteria Mapping** -- for each criterion from assignment.md, which task(s) address it
4. **Risks and Open Questions** -- anything that might block or complicate implementation
5. **Testing Strategy** -- how to verify the implementation works

Write the plan using the Edit tool to update `<assignmentDir>/plan.md`. Preserve the existing frontmatter and replace only the body content.

## Step 5: Report to User

After writing the plan:
1. Summarize the plan (number of tasks, key decisions)
2. Note any open questions or risks that need human input
3. Suggest next step: begin implementing the first task, or run `/complete-assignment` when all work is done

**Remind the agent about recordkeeping during implementation:**
- Check off acceptance criteria in `assignment.md` as each one is completed, not in a batch at the end
- Update the `## Progress` section in `assignment.md` after each meaningful milestone
- The assignment file is a live document — it should reflect current state at all times
