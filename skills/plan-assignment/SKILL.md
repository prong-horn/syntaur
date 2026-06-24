---
name: plan-assignment
description: >-
  Create a detailed implementation plan for the current Syntaur assignment.
  Use when the user wants to plan their work, write a plan file, or design an
  approach for an active assignment.
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# Plan Assignment

Create a versioned implementation plan for your current Syntaur assignment. Plans are versioned files: the first is `plan.md`, subsequent ones are `plan-v2.md`, `plan-v3.md`, and so on. Each plan gets a linked todo in the `## Todos` section of `assignment.md`; prior active plan todos are marked superseded (never deleted).

## Input

Optional: the user may provide focus areas or notes to guide the plan.

## Step 1: Load Context

The active assignment is resolved from the session's open engagement. Run `syntaur session resume --json` to read it. If there is no open engagement (no active assignment), tell the user: "No active assignment for this session — grab one first." and stop. `.syntaur/context.json` is only a workspace marker; do not read the assignment from it.

From the resolved engagement, note:
- `projectSlug` — the project slug (`null` for standalone assignments)
- `assignmentSlug` — the assignment slug
- `assignmentDir` — absolute path to the assignment folder
- `projectDir` — absolute path to the project folder (may be null for standalone)
- `workspaceRoot` — absolute path to the workspace (a workspace marker; may be null)

## Step 2: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/`:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each file found, read it and follow its directives. Playbooks may contain rules about planning conventions, required steps, or quality expectations that take precedence over default conventions.

## Step 3: Read Assignment Details

Read these files to understand the assignment:

1. `<assignmentDir>/assignment.md` — objective, acceptance criteria, context, and the `## Todos` list
2. `<assignmentDir>/comments.md` if present — inherited questions, notes, and feedback
3. `<projectDir>/project.md` — project goal for broader context (skip for standalone)
4. `<projectDir>/manifest.md` — project navigation index (skip for standalone)

Per-project `agent.md` / `claude.md` were removed in protocol v2.0. Agent-level conventions now live at the repo root (`CLAUDE.md` / `AGENTS.md`) and in `~/.syntaur/playbooks/` (already loaded in Step 2).

If the assignment has dependencies (`dependsOn` in frontmatter), read each dependency's `handoff.md` AND `decision-record.md` for integration context and upstream decisions.

## Step 4: Explore Workspace (if set)

If `workspaceRoot` is not null:

1. Check the workspace directory exists.
2. Explore the codebase to understand what exists: find key files (`**/*.ts`, `package.json`, `**/*.md`, etc.), search for relevant patterns mentioned in the assignment, read entry points and config.
3. Note any existing patterns, conventions, or architecture you discover.

If `workspaceRoot` is null, skip this step and note in the plan that no workspace is configured.

## Step 5: Write the Plan

### 5a. Determine the next plan filename

List `<assignmentDir>/plan*.md` and pick the target:

- If no plan files exist → `plan.md` (version label: "plan").
- If `plan.md` exists but no `plan-v<N>.md` → `plan-v2.md` (version label: "plan v2").
- Otherwise pick the smallest `N >= 2` such that `plan-v<N>.md` does not exist (version label: `plan v<N>`).

Remember this `planFilename` and `versionLabel` for Steps 5b and 5c.

### 5b. Write the plan file

**Scaffold via the CLI — do not hand-write the file or frontmatter.**

- **Initial plan** (`planFilename` is `plan.md`, no plan files exist yet): run

  ```bash
  syntaur plan create
  ```

  (or `--assignment <slug> [--project <slug>]` to target one explicitly). This
  writes `plan.md` with the standard `draft` frontmatter AND appends the
  four-todo cycle to assignment.md `## Todos` — so **Step 5c is already done for
  the initial plan**; skip it and proceed to fill in the body sections below.

- **New version** (`planFilename` is `plan-v<N>.md`): run `syntaur plan version`,
  which scaffolds `plan-v<N>.md`, supersedes the prior cycle, and carries forward
  unchecked tasks (this is Step 5c for the versioned case).

The scaffolded frontmatter is:

```yaml
---
assignment: <assignmentSlug>
status: draft
created: "<nowTimestamp>"
updated: "<nowTimestamp>"
---
```

Then edit the scaffolded plan file in place to add the body sections below.

Body sections:

1. **Overview** — one paragraph summarizing the approach.
2. **Tasks** — numbered list; each task has description, files to create/modify (with paths), dependencies on other tasks, and complexity estimate (low/medium/high).
3. **Acceptance Criteria Mapping** — for each criterion from assignment.md, which task(s) address it.
4. **Risks and Open Questions** — anything that might block or complicate implementation.
5. **Testing Strategy** — how to verify the implementation works.

**Decision capture:** While planning, record meaningful choices (library picks, schema design, architectural calls, rejected alternatives) as numbered entries in `<assignmentDir>/decision-record.md` using `## Decision N: <short title>` with Status (proposed/accepted), Context, Decision, Consequences. Downstream assignments that depend on this one auto-load these decisions.

If the target file already exists (only possible for `plan.md` on first re-run against a scaffolded-but-empty plan), preserve the frontmatter and replace only the body, flipping `status` from `draft` to `in_progress` and updating `updated`.

### 5c. Update assignment.md Todos (four-todo cycle)

Read `<assignmentDir>/assignment.md` and locate the `## Todos` section. Per
the **Create-and-Plan-Assignment** playbook, every plan version uses a
four-todo cycle: Create / Review / Implement / Review implementation.

1. **Supersede the prior plan's four-todo cycle.** For every line referencing
   the prior plan file (`./plan.md` or `./plan-v<N-1>.md`) — both the older
   single-line `Execute [...]` form AND the four-todo-cycle lines (Create /
   Review / Implement / Review implementation of) — rewrite as:

   ```
   - [x] ~~<original line body>~~ (superseded by <versionLabel>)
   ```

   Mark the checkbox `[x]` and wrap the body in `~~...~~`. Never delete any
   prior todo — preserve history.

2. **Append the new four-todo cycle.** Add four lines to the end of
   `## Todos`, replacing `<versionLabel>` with the human label (e.g.
   `plan v2`) and `<planFilename>` with the new file (e.g. `plan-v2.md`):

   ```
   - [ ] Create [<versionLabel>](./<planFilename>)
   - [ ] Review [<versionLabel>](./<planFilename>)
   - [ ] Implement [<versionLabel>](./<planFilename>)
   - [ ] Review implementation of [<versionLabel>](./<planFilename>)
   ```

   For the first plan ever (`plan.md`), the label is `plan` and the four todos
   point at `./plan.md`.

3. **Missing-section fallback.** If `## Todos` does not exist (legacy
   assignment predating this convention), insert it immediately after
   `## Acceptance Criteria` with a short guidance HTML comment followed by
   the new four-todo cycle.

Also refresh the assignment frontmatter `updated` timestamp.

> **Note:** the `syntaur plan version` CLI verb (used by the `replan` skill)
> applies this exact same four-todo-cycle supersede pattern — `plan-assignment`
> and `replan` are now in lockstep on this convention.

## Step 6: Report to User

After writing the plan:

1. Summarize the plan (number of tasks, key decisions).
2. Note any open questions or risks that need human input.
3. Call out which plan filename was written and whether any prior plan was superseded.
4. Suggest the next step: begin implementing the first task, or run `complete-assignment` when all work is done.

**Recordkeeping reminders for implementation:**
- Check off acceptance criteria in `assignment.md` as each one is completed — not in a batch at the end.
- Append timestamped milestones to `progress.md` (a separate append-only file). Do NOT add a `## Progress` section to `assignment.md` — protocol v2.0 moved progress to its own file.
- Record questions, notes, or feedback via `syntaur comment <slug-or-uuid> "body" --type question|note|feedback` — never edit `comments.md` directly.
- Keep `assignment.md` status, todos, and acceptance checkboxes reflecting current state at all times.
