---
name: clear-assignment
description: >-
  Clear the active Syntaur assignment from the current session without
  transitioning lifecycle state. Use when the user wants to drop, release,
  unclaim, abandon, or clear assignment context — e.g., "clear my assignment",
  "drop this assignment", "release context", "unclaim this", "I'm not actually
  working on this anymore". Does not mark the assignment complete or failed.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Clear Assignment

Drop the active assignment binding from the current session. The assignment itself is left untouched in `~/.syntaur/projects/.../assignments/` — only the session's open engagement (the binding that makes it the active assignment) is closed so the session is no longer scoped to it. `.syntaur/context.json` is a workspace marker and is not the binding — it does not hold the active assignment.

This is the inverse of `grab-assignment`. Unlike `complete-assignment`, it does **not** transition lifecycle state, write a handoff, or close out the work. Use it when:

- The user grabbed the wrong assignment.
- The user wants to switch focus without finishing or formally reviewing the current one.
- Session context was set up earlier and is now stale.

If the assignment is actually done, use `complete-assignment` instead so a handoff is recorded and the lifecycle state advances.

## Input

Optional flags from the user:

- `--unassign` — also run `syntaur unassign <slug> --project <project>` so the assignment is no longer claimed by this agent. Default: leave the claim in place (only the session's engagement is closed).

## Step 1: Load Context

The active assignment is resolved from the session's open engagement. Run `syntaur session resume --json` to read it.

- If there is no open engagement, tell the user: "No active assignment is bound to this session — nothing to clear." and stop. (`.syntaur/context.json` is only a workspace marker; its presence does not mean an assignment is bound.)

From the resolved engagement, note: `projectSlug`, `assignmentSlug`, `assignmentDir`, `title`.

## Step 2: Confirm with the User

Show the user what is about to be cleared and confirm before touching anything:

> About to clear active assignment context:
> - Assignment: `<assignmentSlug>` — <title>
> - Project: `<projectSlug>` (or "standalone" if null)
> - The assignment itself will NOT be transitioned. Its lifecycle status stays as-is.
> - Proceed?

Stop if the user says no.

If lifecycle status is `in_progress` and the user has not passed `--complete-instead`, also note:

> Note: this assignment is currently `in_progress`. Clearing context does not change that. If you actually finished it, run `complete-assignment` instead so a handoff is recorded.

## Step 3 (optional): Unassign

If the user passed `--unassign`, run:

```bash
syntaur unassign <assignment-slug> --project <project-slug>
```

For standalone assignments use the UUID (the folder name) in place of the slug, and omit `--project`.

`syntaur unassign` clears the assignee on the assignment frontmatter (the inverse of `assign`) and bumps `updated`.

## Step 4: Close the Engagement

Closing the session's open engagement is what drops the active-assignment binding — that is the operation that "clears" the assignment. The dashboard status PATCH in Step 5 (to `cleared`) closes the open engagement for a live session.

Do NOT delete or rewrite `.syntaur/context.json` to clear the assignment — it is a workspace marker and no longer carries the active assignment. Leave its repository/branch/worktree, session, and lease fields intact so other tooling keeps recognizing the workspace. Do not delete the `.syntaur/` directory.

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
- Which assignment was cleared (slug + title).
- That its lifecycle status is unchanged (and what that status currently is, if known from frontmatter).
- Whether the assignment was unassigned via the CLI or the claim was left in place.
- Suggested next step: `grab-assignment` to claim a different one, or `complete-assignment` if the previous one was actually finished.
