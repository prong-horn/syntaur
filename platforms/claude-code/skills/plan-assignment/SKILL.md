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

If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <project-slug>` first to claim an assignment."

Extract from the context file:
- `projectSlug` -- the project slug
- `assignmentSlug` -- the assignment slug
- `assignmentDir` -- absolute path to the assignment folder
- `projectDir` -- absolute path to the project folder
- `workspaceRoot` -- absolute path to the workspace (may be null)

## Step 1.5: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/` — these contain user-defined behavioral rules you must follow:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each file found, read it and follow its directives. Playbooks may contain rules about planning conventions, required steps, or quality expectations that apply to this plan.

## Step 2: Read Assignment Details

Read the following files to understand the assignment:

1. Read `<assignmentDir>/assignment.md` -- extract the objective, acceptance criteria, context section, and the `## Todos` list
2. Read `<assignmentDir>/comments.md` if it exists -- inherited questions, notes, and feedback
3. Read `<projectDir>/project.md` -- extract the project goal for broader context
4. Read `<projectDir>/manifest.md` -- navigation index for the project

Per-project `agent.md` and `claude.md` were removed in v0.2.0. The agent-level
conventions now live in the repo root `CLAUDE.md` / `AGENTS.md` and in
`~/.syntaur/playbooks/`, which Step 1.5 already loaded.

If the assignment has dependencies (`dependsOn` in frontmatter), read each
dependency's `handoff.md` and `decision-record.md` for integration context and
upstream decisions:
- `<projectDir>/assignments/<dep-slug>/handoff.md`
- `<projectDir>/assignments/<dep-slug>/decision-record.md`

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

Plans are versioned. The first plan for an assignment is `plan.md`; subsequent plans are `plan-v2.md`, `plan-v3.md`, etc. Each plan gets a linked entry in the `## Todos` section of `assignment.md`, and any prior active plan todo is marked superseded (never deleted).

### 4a. Determine the next plan filename

Use Glob to list `<assignmentDir>/plan*.md`. Then:

- If no plan files exist, the target is `plan.md` and the version label is "plan".
- If `plan.md` exists but no `plan-v<N>.md`, the target is `plan-v2.md` and the version label is "plan v2".
- Otherwise, pick the smallest `N >= 2` such that `plan-v<N>.md` does not exist. The version label is `plan v<N>`.

Remember this `planFilename` and `versionLabel` for the remaining substeps.

### 4b. Write the plan file

Write `<assignmentDir>/<planFilename>` with standard plan frontmatter:

```yaml
---
assignment: <assignmentSlug>
status: draft
created: "<nowTimestamp>"
updated: "<nowTimestamp>"
---
```

Then the markdown body should include:

1. **Overview** -- one paragraph summarizing the approach
2. **Tasks** -- numbered list of implementation tasks, each with:
   - Description of what to do
   - Files to create or modify (with paths)
   - Dependencies on other tasks
   - Estimated complexity (low/medium/high)
3. **Acceptance Criteria Mapping** -- for each criterion from assignment.md, which task(s) address it
4. **Risks and Open Questions** -- anything that might block or complicate implementation
5. **Testing Strategy** -- how to verify the implementation works

**Decision capture:** While planning, note any meaningful choices you make (library picks, schema design, architectural calls, rejected alternatives). Record each as a numbered entry in `<assignmentDir>/decision-record.md` with the format `## Decision N: <short title>` — fields: Status (proposed/accepted), Context, Decision, Consequences. Downstream assignments that depend on this one auto-load these decisions during `/grab-assignment`, so they pay off over time.

If the target file already exists (only possible for `plan.md` on first re-run against a scaffolded-but-empty plan), preserve the frontmatter and replace only the body, flipping `status` from `draft` to `in_progress` and updating `updated`.

### 4c. Update assignment.md Todos

Read `<assignmentDir>/assignment.md` and locate the `## Todos` section.

1. **Supersede prior plan todos.** Scan unchecked todo lines for any that match the pattern `- [ ] Execute [<label>](./plan.md)` or `- [ ] Execute [<label>](./plan-v<N>.md)`. For each match, rewrite the line as:

   ```
   - [x] ~~Execute [<label>](./<old-plan-filename>)~~ (superseded by <versionLabel>)
   ```

   Never delete the old line — preserve history.

2. **Append the new plan todo.** Append a new line to the end of the `## Todos` section:

   ```
   - [ ] Execute [<versionLabel>](./<planFilename>)
   ```

3. **Missing section fallback.** If the `## Todos` section does not exist (legacy assignment predating this convention), insert it immediately after `## Acceptance Criteria` with a short guidance HTML comment followed by the new todo line. Match the template used by `/create-assignment`.

Also update the assignment frontmatter `updated` timestamp.

## Step 5: Report to User

After writing the plan:
1. Summarize the plan (number of tasks, key decisions)
2. Note any open questions or risks that need human input
3. Suggest next step: begin implementing the first task, or run `/complete-assignment` when all work is done

**Remind the agent about recordkeeping during implementation:**
- Check off acceptance criteria in `assignment.md` as each one is completed, not in a batch at the end
- Append timestamped milestones to `progress.md` (separate append-only file) — not to `assignment.md`
- Use `syntaur comment <slug-or-uuid> "body" --type note|question|feedback` to add a comment to `comments.md`
- `assignment.md` is a live document — keep its status, todos, and acceptance checkboxes reflecting current state at all times
