---
name: resume-session
description: >-
  Re-orient a fresh Syntaur session on the active ticket without
  re-reading the full transcript. Resolves the active ticket from the
  session's open engagement and loads the latest handoff log entry. Use when the user says
  "resume", "pick up where we left off", "continue this ticket", or after
  a compact / new session start.
license: MIT
metadata:
  author: prong-horn
  version: "2.0.0"
---

# Resume Session

Print a compact orientation block so the agent (and the user) can pick up the
active ticket cleanly. **Idempotent — does not mutate any state.**

## When NOT to use this skill

- Cross-ticket handoff to a downstream ticket — that's `complete-ticket`
  (`syntaur log -t handoff`).
- First-time grab of a ticket — use `/grab-ticket` instead.

## Step 1: Verify there is an active ticket

Run `syntaur session resume`. The CLI resolves the open engagement, reads the
latest `handoff` log entry (or legacy `handoff.md` when present), and prints
project, ticket, branch, workspace root, and handoff summary.

## Step 2: Read the open handoff (when present)

If the CLI reported a handoff, treat it as the highest-priority signal.

## Step 3: Read ticket.md and recent log entries

Read `ticket.md` (objective, acceptance criteria) and the tail of the log role
via `syntaur show --log` or the dashboard **Journal** tab.

## Step 4: Idempotency check (optional)

Re-run `syntaur session resume --json` to confirm nothing changed on disk.

## Step 5: Report to User

Summarize active project / ticket / branch, handoff status, and suggested next action.
