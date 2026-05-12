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

## Step 2: Pre-write validation

```bash
syntaur doctor --assignment <assignmentDir>/assignment.md --json
```

Parse the JSON output. If `ok: false`, refuse to proceed. Report the
`errors[]` to the user verbatim and recommend they fix the underlying
frontmatter (or run `syntaur doctor` for the broader project context).
**Do not write any changes if the file is malformed.**

## Step 3: Gather inputs

Required (one or more — at minimum the user must specify enough to fill
all four fields):

- `--repository <path>` — repo root (typically `git rev-parse --show-toplevel`).
- `--worktree-path <path>` — usually `<repository>/.worktrees/<branch>`
  per the repo-local convention.
- `--branch <name>` — current branch (`git rev-parse --abbrev-ref HEAD`).
- `--parent-branch <name>` — typically `main`.

Defaults the skill should auto-detect when not supplied:

- `repository` ← `git -C $(pwd) rev-parse --show-toplevel`.
- `branch` ← `git -C $(pwd) rev-parse --abbrev-ref HEAD`.
- `worktreePath` ← `$(pwd)` (when invoked from the worktree itself).
- `parentBranch` ← prompt the user; do not invent.

## Step 4: Read assignment.md

Locate the `workspace:` block in the frontmatter. It must look like:

```yaml
workspace:
  repository: <value-or-null>
  worktreePath: <value-or-null>
  branch: <value-or-null>
  parentBranch: <value-or-null>
```

If the block is missing entirely, refuse to write — `doctor --assignment`
should have caught it; this is a defensive check.

## Step 5: Write the four fields

Replace the four lines in place. Quote string values containing special
characters; use `null` literal for unset fields. Preserve the rest of the
frontmatter and body bit-for-bit.

Bump the top-level `updated` timestamp in the frontmatter.

## Step 6: Re-validate

Re-run `syntaur doctor --assignment <path> --json`. Expect `ok: true`. If
the post-write validation fails, restore the prior file content and report
the error — do not leave the file in a half-written state.

## Step 7: Report to User

Summarize:

- Path of the modified assignment.md.
- The four field values that were written.
- Confirmation that post-write `doctor --assignment` passed.
- Reminder: implementation work is now unblocked by the write-boundary hook.
