---
name: resume-session
description: >-
  Re-orient a fresh Syntaur session on the active ticket without
  re-reading the full transcript. Resolves the active ticket from the
  session's open engagement and loads any open handoff. Use when the user says
  "resume", "pick up where we left off", "continue this ticket", or after
  a compact / new session start.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Resume Session

Print a compact orientation block so the agent (and the user) can pick up the
active ticket cleanly. **Idempotent — does not mutate any state.** Re-run
freely; nothing on disk changes.

## When NOT to use this skill

- Cross-ticket handoff to a downstream ticket — that's `complete-ticket`
  (writes `handoff.md`).
- First-time grab of an ticket — use `/grab-ticket` instead; this skill
  assumes context already exists.

## Step 1: Verify there is an active ticket

Run `syntaur session resume`. The CLI:

1. Resolves the active ticket from the session's OPEN engagement (the
   ticket this session is currently bound to). `.syntaur/context.json` is
   only a workspace marker — it identifies the repository/branch/worktree, not
   the active ticket.
2. Aborts (exit 1) with a clear message when there is no open engagement —
   "No active ticket for this session — grab one first" — telling the user
   to run `grab-ticket`.
3. Otherwise resolves the ticket dir from the engagement and reads
   `<ticketDir>/handoff.md` (the canonical single-file handoff per
   ticket, managed by `complete-ticket`) and reports it if its body
   has been written beyond the scaffolded placeholder.
4. Prints a human-readable orientation block (project, ticket, branch,
   workspace root, open handoff).

## Step 2: Read the open handoff (when present)

If the CLI reported an open handoff, read that file. It is the highest
priority signal — there is an outstanding baton to consume.

## Step 3: Read ticket.md and progress.md

Always read the current ticket.md (objective, acceptance criteria)
and the tail of progress.md so you know what has been logged since the last
handoff.

## Step 4: Idempotency check (optional)

Re-run `syntaur session resume --json` if you want machine-readable confirmation
that nothing on disk changed between runs. The output is deterministic for a
given on-disk state.

## Step 5: Report to User

Summarize:

- Active project / ticket / branch.
- Whether there is an open handoff (and a one-line summary if so).
- Suggested next concrete action.
