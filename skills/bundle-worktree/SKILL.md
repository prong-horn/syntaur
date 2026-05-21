---
name: bundle-worktree
description: >-
  Create a git worktree for a Syntaur todo bundle and bind it to the
  current agent session. Use when the user wants to "make a worktree for
  this bundle", "spin up an isolated workspace for bundle b:xxxx", or set
  up parallel work on a different bundle.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Bundle Worktree

Atomic worktree-and-bind for a Syntaur todo bundle. Unlike the assignment
equivalent (`/syntaur-worktree`), bundles have no lifecycle to transition
— this skill only creates the worktree, persists the workspace on the
bundle + every member, and writes a bundle-shaped `.syntaur/context.json`
inside the new worktree.

## When NOT to use this skill

- The bundle already has a `worktreePath` set — `syntaur todo bundle show`
  will print it; use it instead. The CLI will refuse a second worktree.
- You want a worktree for an assignment, not a bundle — use
  `/syntaur-worktree` instead.

## Step 1: Resolve inputs

Required:

- `--branch <name>` — the new branch name (also the worktree dir name).

Optional (with sensible defaults):

- `--repository <path>` — defaults to the current working directory.
- `--parent-branch <name>` — defaults to `main`.
- `--worktree-path <path>` — defaults to `<repository>/.worktrees/<branch>`.
- A bundle id positional, OR scope flags + the active context's `bundleId`.

The computed worktree path is **always**
`<repository>/.worktrees/<branch>` (never `.claude/worktrees`, never
`~/.syntaur/worktrees`). Repo-local convention.

## Step 2: Pre-flight

- Confirm `.syntaur/context.json` is a bundle context (has `bundleId`,
  no assignment fields). If it's an assignment context, stop and tell the
  user to `/grab-bundle <id>` first.
- Confirm `<repository>/.git` exists.
- Confirm the branch does NOT already exist. If it does, the CLI will
  surface a `GitWorktreeError` — surface that verbatim.
- Confirm the bundle's existing `worktreePath` is null. The CLI rejects a
  second worktree.

## Step 3: Create worktree + bind

```bash
syntaur todo bundle worktree <bundle-id> \
  --branch <branch> \
  --repository <repository> \
  --parent-branch <parent-branch> \
  <scope flags>
```

The CLI handles the entire transactional flow via
`createWorktreeForBundle` in `src/utils/git-worktree.ts`. On any failure
between `git worktree add` and the persistence writes, the worktree and
branch are removed and the error is tagged `'bundle storage'`.

## Step 4: cd into the new worktree

After the CLI prints `Created worktree at <path>`, `cd` into that path.
The bundle context.json was already written inside it, so a new session
started from that directory will read bundle fields automatically.

## Step 5: Confirm context

```bash
cat .syntaur/context.json
```

The JSON should contain `bundleId`, `bundleScope`, `bundleScopeId`,
`todoIds`, `branch`, `worktreePath`, `repository`, `boundAt` — and NO
`assignmentDir` / `assignmentSlug` / `projectSlug`. If you see assignment
fields, stop — something is wrong; the CLI should never emit a mixed
context. Report the issue.

## Step 6: Report to user

- New worktree path.
- Branch + parent branch.
- Bundle id + member count.
- Repository absolute path.
- Reminder to `cd` into the new worktree (if the parent shell is not
  already there).
- Note that subsequent agent sessions opened in this directory will read
  the bundle fields automatically.

## Step 7: Mirror skills (if you also edited the skill file)

If this session also touched `skills/<name>/SKILL.md`, run:

```bash
npm run mirror-skills
```
