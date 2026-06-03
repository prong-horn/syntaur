---
name: set-workspace
description: >-
  Populate the four `workspace.*` fields (repository, worktreePath, branch,
  parentBranch) in the active assignment's `assignment.md` frontmatter
  before any implementation code is written. Use after creating a worktree,
  picking a branch, or any time the user wants to "set the workspace",
  "wire the assignment to a branch", or per the Workspace Before Code
  playbook. Validates frontmatter via `syntaur doctor --assignment --json`
  before writing — refuses to touch a malformed file.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Set Workspace

Write the four canonical `workspace.*` fields in `assignment.md` frontmatter
so that the PreToolUse write-boundary hook will allow implementation work.
Validates the file first via `syntaur doctor --assignment --json` and
refuses to write on errors.

This skill implements the **Workspace Before Code** playbook: never write
implementation code until workspace fields are set.

## When NOT to use this skill

- The workspace fields are already set correctly. Read the assignment.md
  first; if all four fields match the intended values, do nothing.
- You want to create the worktree itself — use `/syntaur-worktree`, which
  composes worktree creation AND workspace field updates in one move.
- The assignment is in a terminal status (`completed`, `failed`,
  `cancelled`). Reopen it first if you really need to change workspace.

## Step 1: Resolve the assignment file

Read `.syntaur/context.json` from the current working directory. Extract
`assignmentDir`. The target file is `<assignmentDir>/assignment.md`.

If no context, abort with: "No active assignment. Run `grab-assignment`
first."

## Step 2: Gather inputs

At minimum specify enough to fill the four fields:

- `--repository <path>` — repo root (typically `git rev-parse --show-toplevel`).
- `--worktree-path <path>` — usually `<repository>/.worktrees/<branch>`
  per the repo-local convention.
- `--branch <name>` — current branch (`git rev-parse --abbrev-ref HEAD`).
- `--parent-branch <name>` — typically `main`.

Defaults to auto-detect when not supplied:

- `repository` ← `git -C $(pwd) rev-parse --show-toplevel`.
- `branch` ← `git -C $(pwd) rev-parse --abbrev-ref HEAD`.
- `worktreePath` ← `$(pwd)` (when invoked from the worktree itself).
- `parentBranch` ← prompt the user; do not invent.

## Step 3: Write via the CLI

```bash
syntaur workspace set \
  --repository <repo> \
  --worktree-path <repo>/.worktrees/<branch> \
  --branch <branch> \
  --parent-branch <parent>
```

Targets the active assignment from `.syntaur/context.json` by default; pass
`--assignment <slug> [--project <slug>]` to target one explicitly. The command
does the whole safe write in one atomic step:

- **Pre-write validation** — runs the same checks as `syntaur doctor
  --assignment --json`; if the file is malformed it refuses to write and prints
  the errors. (Implements the "never touch a malformed file" guard.)
- Writes the four `workspace.*` fields in place via the frontmatter mutator
  (other same-named keys elsewhere are untouched) and bumps the top-level
  `updated` timestamp.
- **Post-write re-validation** — if the result is somehow invalid, it restores
  the original file and exits non-zero, so the file is never left half-written.

If the command exits non-zero, report its `Error:` output verbatim and fix the
underlying frontmatter before retrying.

## Step 4: Report to User

Summarize:

- Path of the modified assignment.md (the command prints it).
- The four field values that were written.
- Reminder: implementation work is now unblocked by the write-boundary hook.
