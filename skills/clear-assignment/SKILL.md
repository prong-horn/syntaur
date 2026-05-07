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

Drop the active assignment binding from the current workspace. The assignment itself is left untouched in `~/.syntaur/projects/.../assignments/` — only the local `.syntaur/context.json` pointer is cleared so the session is no longer scoped to it.

This is the inverse of `grab-assignment`. Unlike `complete-assignment`, it does **not** transition lifecycle state, write a handoff, or close out the work. Use it when:

- The user grabbed the wrong assignment.
- The user wants to switch focus without finishing or formally reviewing the current one.
- Session context was set up earlier and is now stale.

If the assignment is actually done, use `complete-assignment` instead so a handoff is recorded and the lifecycle state advances.

## Input

Optional flags from the user:

- `--keep-session` — preserve `sessionId` / `transcriptPath` fields in `context.json` (just strip the assignment fields). Default: full delete.
- `--unassign` — also run `syntaur unassign <slug> --project <project>` so the assignment is no longer claimed by this agent. Default: leave the claim in place (only the local context is cleared). Skip this flag if the CLI does not support `unassign` in the installed version — fall back to leaving the claim alone and tell the user.

## Step 1: Load Context

Read `.syntaur/context.json` from the current working directory.

- If the file does not exist, tell the user: "No active assignment context to clear." and stop.
- If the file exists but contains only session fields (`sessionId`, `transcriptPath`) and no `projectSlug` / `assignmentSlug`, tell the user: "No active assignment is bound — only a platform session record exists. Nothing to clear." and stop (unless they explicitly ask to wipe the session record too).

Otherwise extract: `projectSlug`, `assignmentSlug`, `assignmentDir`, `title`.

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

If the CLI rejects the command (older versions may not implement `unassign`), report the error and continue — the local context clear in Step 4 still happens.

## Step 4: Clear the Context File

Default behavior — delete the file entirely:

```bash
rm .syntaur/context.json
```

If the user passed `--keep-session`, preserve session fields and strip everything else instead:

```bash
jq '{sessionId, transcriptPath} | with_entries(select(.value != null))' \
  .syntaur/context.json > .syntaur/context.json.tmp \
  && mv .syntaur/context.json.tmp .syntaur/context.json
```

If the resulting file would be empty (`{}`), delete it instead of leaving an empty stub.

Do not delete the `.syntaur/` directory itself — other tooling may use it.

## Step 5: Close Session (optional)

If the original `context.json` included a `sessionId` and the Syntaur dashboard is running, mark the session as cleared so the dashboard does not keep showing it as active:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"cleared","projectSlug":"<project-slug>"}'
```

If this fails (e.g., dashboard not running, endpoint not present in the installed version), it is non-critical — silently continue.

Skip this step entirely when `--keep-session` is set.

## Step 6: Report to User

Summarize:
- Which assignment was cleared (slug + title).
- That its lifecycle status is unchanged (and what that status currently is, if known from frontmatter).
- Whether the assignment was unassigned via the CLI or the claim was left in place.
- Suggested next step: `grab-assignment` to claim a different one, or `complete-assignment` if the previous one was actually finished.
