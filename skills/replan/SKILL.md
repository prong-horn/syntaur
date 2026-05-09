---
name: replan
description: >-
  Create a new versioned plan (`plan-v<N>.md`) for the active Syntaur
  assignment after the current plan has been implemented (or a major scope
  shift makes editing the existing plan misleading). Use when the user wants to
  "create plan-v2", "replan", "version the plan", "make a new plan revision",
  or when work needs another round under the Plan Versioning playbook.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Replan

Bump the active assignment to a new plan version (`plan.md` → `plan-v2.md`,
`plan-v2.md` → `plan-v3.md`, …). The CLI does the deterministic file ops; this
skill writes the **body** of the new plan.

This skill follows the **Plan Versioning** and **Create-and-Plan-Assignment**
playbooks: prior plan-cycle todos are marked done with strikethrough +
`(superseded by plan-v<N>)`, and a fresh four-todo cycle (Create / Review /
Implement / Review implementation) is appended for the new plan. **Superseded
todos are never deleted.**

## When NOT to use this skill

- The current plan has not been implemented yet — per the Plan Versioning
  playbook, iterate on `plan.md` directly while it is still in draft /
  in_progress.
- The assignment is in a terminal status (`completed`, `failed`, `cancelled`).
  Reopen it first via `syntaur reopen`.
- You only need to add a new task to an in-flight plan — edit the existing
  plan; do not bump version.
- You want to write a fresh plan for a different assignment — switch context
  via `clear-assignment` + `grab-assignment`, then call `plan-assignment`.

## Step 1: Verify there is an active assignment

Read `.syntaur/context.json` from the current working directory. Extract
`assignmentSlug`, `projectSlug` (may be null for standalone), and
`assignmentDir`.

If the file is missing or has no `assignmentSlug`, abort with: "No active
Syntaur assignment. Run `grab-assignment` first." Do not invent values.

## Step 2: Confirm the prior plan was implemented

Read the current plan file (the highest existing `plan*.md`). If its
`## Tasks` (or equivalent) section still contains unchecked items AND the user
has not explicitly said the prior plan is done, ask: "The current plan still
has N unchecked tasks. Are you sure you want to create plan-v<N>? (Plan
Versioning playbook recommends iterating on `plan.md` until implementation
is complete.)" Stop unless the user confirms.

## Step 3: Run `syntaur plan version`

```bash
syntaur plan version --assignment <assignmentSlug> [--project <projectSlug>]
```

This is the only file-mutating step the skill performs through the CLI. It:

1. Picks the next available `plan-v<N>.md` filename.
2. Writes a stub plan with frontmatter and a `## Carried-forward tasks`
   section pre-populated with any unchecked todos from the prior plan body.
3. Rewrites the assignment.md `## Todos` section per the four-todo cycle:
   marks the four prior plan-cycle todos as
   `- [x] ~~<original>~~ (superseded by plan-v<N>)` and appends a fresh
   `Create / Review / Implement / Review implementation` cycle pointing at the
   new file.
4. Never deletes any prior todo.

If the CLI exits non-zero, surface the error to the user and stop.

## Step 4: Read the prior plan and the new stub

Read the prior `plan*.md` and the freshly created `plan-v<N>.md`. The stub
already contains:

- Frontmatter (`assignment`, `status: draft`, `created`, `updated`)
- A heading
- A `## Objective` section with a placeholder
- A `## Carried-forward tasks` section
- Empty `## Tasks` and `## Verification` sections

## Step 5: Write the new plan body

Replace the placeholder content in the stub with a concrete, implementable
plan for the new revision. Match the structure of the prior plan (Files /
Tasks / Verification, etc.) but keep the body concise. Document explicitly
**why** a new revision is needed (e.g., "scope expanded after review",
"rework after partial implementation").

Do NOT touch `assignment.md` here — the CLI already updated `## Todos`.

## Step 6: Update progress.md

Append a progress entry recording the new plan version, the reason, and a
pointer to the new plan file.

## Step 7: Report to User

Summarize:

- New plan path (`<assignmentDir>/plan-v<N>.md`).
- Number of carried-forward unchecked tasks.
- Number of prior todos rewritten as superseded (should be the four-todo
  cycle of the previous plan).
- Reminder: prior plan files are kept on disk as immutable history; do not
  delete them.
- Next step: review the new plan and begin the new four-todo cycle.
