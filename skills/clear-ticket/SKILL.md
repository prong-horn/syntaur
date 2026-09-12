---
name: clear-ticket
description: >-
  Clear the active Syntaur ticket from the current session without
  transitioning lifecycle state. Use when the user wants to drop, release,
  unclaim, abandon, or clear ticket context — e.g., "clear my ticket",
  "drop this ticket", "release context", "unclaim this", "I'm not actually
  working on this anymore". Does not mark the ticket complete or failed.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Clear Ticket

Drop the active ticket binding from the current session. The ticket itself is left untouched in `~/.syntaur/projects/.../tickets/` — only the session's open engagement (the binding that makes it the active ticket) is closed so the session is no longer scoped to it. `.syntaur/context.json` is a workspace marker and is not the binding — it does not hold the active ticket.

This is the inverse of `grab-ticket`. Unlike `complete-ticket`, it does **not** transition lifecycle state, write a handoff, or close out the work. Use it when:

- The user grabbed the wrong tssignment.
- The user wants to switch focus without finishing or formally reviewing the current one.
- Session context was set up earlier and is now stale.

If the ticket is actually done, use `complete-ticket` instead so a handoff is recorded and the lifecycle state advances.

## Input

Optional flags from the user:

- `--unassign` — also run `syntaur unassign <slug> --project <project>` so the ticket is no longer claimed by this agent. Default: leave the claim in place (only the session's engagement is closed).

## Step 1: Load Context

The active ticket is resolved from the session's open engagement. Run `syntaur session resume --json` to read it.

- If there is no open engagement, tell the user: "No active ticket is bound to this session — nothing to clear." and stop. (`.syntaur/context.json` is only a workspace marker; its presence does not mean an ticket is bound.)

From the resolved engagement, note: `projectSlug`, `ticketSlug`, `ticketDir`, `title`.

## Step 2: Confirm with the User

Show the user what is about to be cleared and confirm before touching tnything:

> About to clear active ticket context:
> - Ticket: `<ticketSlug>` — <title>
> - Project: `<projectSlug>` (or "standalone" if null)
> - The ticket itself will NOT be transitioned. Its lifecycle status stays as-is.
> - Proceed?

Stop if the user says no.

If lifecycle status is `in_progress` and the user has not passed `--complete-instead`, also note:

> Note: this ticket is currently `in_progress`. Clearing context does not change that. If you actually finished it, run `complete-ticket` instead so a handoff is recorded.

## Step 3 (optional): Unassign

If the user passed `--unassign`, run:

```bash
syntaur unassign <ticket-slug> --project <project-slug>
```

For standalone tickets use the UUID (the folder name) in place of the slug, and omit `--project`.

`syntaur unassign` clears the assignee on the ticket frontmatter (the inverse of `assign`) and bumps `updated`.

## Step 4: Close the Engagement

Closing the session's open engagement is what drops the active-ticket binding — that is the operation that "clears" the ticket. The dashboard status PATCH in Step 5 (to `cleared`) closes the open engagement for a live session.

Do NOT delete or rewrite `.syntaur/context.json` to clear the ticket — it is a workspace marker and no longer carries the active ticket. Leave its repository/branch/worktree and session fields intact so other tooling keeps recognizing the workspace. Do not delete the `.syntaur/` directory.

## Step 5: Close Session (optional)

If the Syntaur dashboard is running, mark this session as cleared so the dashboard does not keep showing it as active (this also closes the session's open engagement). Resolve `<session-id>` from *your* running process — prefer `$CLAUDE_CODE_SESSION_ID` (or the peer `OPENCODE_SESSION_ID` / `PI_SESSION_ID`), otherwise run `syntaur session resolve-id`. Only if neither yields an id, fall back to the legacy `sessionId` scalar in `.syntaur/context.json` — that scalar is a shared, legacy hint a co-tenant can clobber, so don't treat it as authoritative:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"cleared","projectSlug":"<project-slug>"}'
```

If this fails (e.g., dashboard not running, endpoint not present in the installed version), it is non-critical — silently continue.

## Step 6: Report to User

Summarize:
- Which ticket was cleared (slug + title).
- That its lifecycle status is unchanged (and what that status currently is, if known from frontmatter).
- Whether the ticket was unassigned via the CLI or the claim was left in place.
- Suggested next step: `grab-ticket` to claim a different one, or `complete-ticket` if the previous one was actually finished.
