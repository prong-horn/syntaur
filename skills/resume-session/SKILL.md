---
name: resume-session
description: >-
  Re-orient a fresh Syntaur session on the active assignment without
  re-reading the full transcript. Resolves the active assignment from the
  session's open engagement and loads any open handoff. Use when the user says
  "resume", "pick up where we left off", "continue this assignment", or after
  a compact / new session start.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Resume Session

Print a compact orientation block so the agent (and the user) can pick up the
active assignment cleanly. **Idempotent — does not mutate any state.** Re-run
freely; nothing on disk changes.

## When NOT to use this skill

- Cross-ticket handoff to a downstream assignment — that's `complete-assignment`
  (writes `handoff.md`).
- First-time grab of an assignment — use `/grab-assignment` instead; this skill
  assumes context already exists.

## Step 1: Verify there is an active assignment

Run `syntaur session resume`. The CLI:

1. Resolves the active assignment from the session's OPEN engagement (the
   assignment this session is currently bound to). `.syntaur/context.json` is
   only a workspace marker — it identifies the repository/branch/worktree, not
   the active assignment.
2. Aborts (exit 1) with a clear message when there is no open engagement —
   "No active assignment for this session — grab one first" — telling the user
   to run `grab-assignment`.
3. Otherwise resolves the assignment dir from the engagement and reads
   `<assignmentDir>/handoff.md` (the canonical single-file handoff per
   assignment, managed by `complete-assignment`) and reports it if its body
   has been written beyond the scaffolded placeholder.
4. Prints a human-readable orientation block (project, assignment, branch,
   workspace root, open handoff).

## Step 2: Read the open handoff (when present)

If the CLI reported an open handoff, read that file. It is the highest
priority signal — there is an outstanding baton to consume.

## Step 3: Read assignment.md and progress.md

Always read the current assignment.md (objective, acceptance criteria)
and the tail of progress.md so you know what has been logged since the last
handoff.

## Step 4: Idempotency check (optional)

Re-run `syntaur session resume --json` if you want machine-readable confirmation
that nothing on disk changed between runs. The output is deterministic for a
given on-disk state.

## Step 5: Report to User

Summarize:

- Active project / assignment / branch.
- Whether there is an open handoff (and a one-line summary if so).
- Suggested next concrete action.
