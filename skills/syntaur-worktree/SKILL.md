---
name: syntaur-worktree
description: >-
  Create a git worktree for a Syntaur assignment under
  `<repo>/.worktrees/<branch>`, claim the assignment, and bind the new
  workspace to the agent session — all in one move. Use when the user wants
  to "make a worktree", "branch + worktree for this assignment", "spin up an
  isolated workspace", or set up parallel work on a different assignment.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Syntaur Worktree

Atomic worktree-and-grab for a Syntaur assignment. Composes four lower-level
operations:

1. `git worktree add` (via `syntaur worktree create`) — repo-local convention
   `<repository>/.worktrees/<branch>`.
2. Update `assignment.md` workspace fields (done by the same CLI verb,
   transactionally — rolls back the worktree on write failure).
3. `syntaur assign` + `syntaur start` — claim the assignment for this agent
   and transition to `in_progress`.
4. Write `.syntaur/context.json` (a workspace marker) inside the new worktree,
   then `syntaur track-session` to bind the session's engagement to the
   assignment.

## When NOT to use this skill

- You only want to create a git worktree outside of Syntaur — use
  `git worktree add` directly. This skill assumes a Syntaur assignment exists.
- The assignment already has a worktree path set in `assignment.md` workspace
  fields. Check first; reuse the existing path.
- You want to grab an assignment without creating a worktree — use
  `/grab-assignment` directly.

## Step 1: Resolve inputs

Required arguments from the user (or interactive prompts):

- `--project <slug>` (omit for standalone assignments — pass `--id <uuid>`)
- `--assignment <slug-or-uuid>`
- `--branch <name>` — the new branch name (also the worktree dir name)
- `--repository <path>` — defaults to current working directory; usually the
  repo root the assignment lives in
- `--parent-branch <name>` — defaults to `main`

The computed worktree path is **always**
`<repository>/.worktrees/<branch>`. Never `.claude/worktrees/`. Never
`~/.syntaur/worktrees/...`. The repo-local convention is enforced.

## Step 2: Pre-flight

- Confirm `<repository>/.git` exists.
- Confirm the branch does NOT already exist (otherwise the CLI will fail
  cleanly — surface that error).
- Confirm the assignment is not in a terminal status. If it is, suggest
  `syntaur reopen` first.

## Step 3: Create worktree + record workspace

```bash
syntaur worktree create \
  --repository <repository> \
  --branch <branch> \
  --parent-branch <parent-branch> \
  --assignment <slug-or-uuid> \
  --project <project-slug>
```

The CLI handles atomicity — on any failure the worktree (if created) and the
new branch are removed.

## Step 4: Claim the assignment

```bash
syntaur assign <assignment> --agent <your-agent-name> --project <project-slug>
syntaur start <assignment> --project <project-slug>   # only if status was pending
```

Skip `start` for any non-`pending` status — never rewind a `review`,
`completed`, or `failed` assignment.

## Step 5: Write the workspace marker

`cd` into the new worktree path. Write `<worktreePath>/.syntaur/context.json`
mirroring the WORKSPACE-MARKER format produced by `/grab-assignment`:
`repository`, `branch`, `worktreePath`, `workspaceRoot`, `grabbedAt`, plus
`sessionId` / `transcriptPath` when known. Do NOT write `projectSlug` /
`assignmentSlug` / `assignmentDir` / `projectDir` / `title` — context.json is a
workspace marker, not the active-assignment source. The assignment binds in the
next step via the session's engagement (`track-session`).

If the runtime exposes a real session id (e.g. Claude Code's
`~/.claude/sessions/`), include it. Otherwise omit `sessionId` entirely; the
SessionStart hook will populate it on next run.

## Step 6: Register the session with the dashboard

```bash
syntaur track-session \
  --project <project-slug> --assignment <assignment-slug> \
  --agent <your-agent-name> \
  --session-id <real-id> \
  --path "$(pwd)"
```

Skip if no real session id is available. Surface the failure non-fatally.

## Step 7: Report to User

Summarize:

- New worktree path (`<repository>/.worktrees/<branch>`).
- Branch + parent branch.
- Assignment slug, project slug, new status.
- Whether the session was registered with the dashboard.
- Reminder to `cd` into the new worktree if the parent shell is not already
  there.
