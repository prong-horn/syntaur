---
name: save-session-summary
description: >-
  Write a per-session continuity summary so a future session can resume cleanly
  without re-reading the full transcript. Use when the user asks to save session
  state, prepare to compact, or hand off mid-assignment to a new session of the
  same agent. Triggered by `/save-session-summary`, by Claude Code's PreCompact
  hook, or when the user says "save the session" / "before we compact" / similar.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Save Session Summary

Write or overwrite the current session's continuity summary at
`<assignmentDir>/sessions/<sessionId>/summary.md`. This is **session-scoped
mid-assignment continuity** — distinct from `handoff.md`, which is the
**assignment-level cross-ticket outbound** doc written by `complete-assignment`.

## When NOT to use this skill

- Use `complete-assignment` instead when finishing the assignment for a downstream ticket / human reviewer — that writes `handoff.md`.
- Do not write to `handoff.md` here. The two artifacts are separate.

## Step 1: Load Context

Read `.syntaur/context.json` from the current working directory.

If the file does not exist, tell the user: "No active assignment found. Run `grab-assignment` first." and stop.

Extract:
- `assignmentDir` (absolute path) — required.
- `sessionId` — required, must be the real agent runtime session id.

If `sessionId` is missing, empty, or `null`, abort with: "Session not tracked. Run `syntaur track-session ...` first." Do not invent or generate a session id.

## Step 2: Ensure Session Directory

Create `<assignmentDir>/sessions/<sessionId>/` only at this step (not earlier — empty session dirs are noise). Use `mkdir -p` semantics so re-saves are idempotent.

## Step 3: Read Existing Summary (if any)

If `<assignmentDir>/sessions/<sessionId>/summary.md` already exists, read it and preserve its `created` frontmatter timestamp. Otherwise, the new file's `created` is now.

This is a **single document per session id** — every save in the same session overwrites in place. The directory partitions by session id, so older sessions remain on disk as immutable history.

## Step 4: Write the Summary

Write `<assignmentDir>/sessions/<sessionId>/summary.md` with this structure (overwrite if it exists). Fill the section bodies with content derived from this session's actual work — be specific and concrete, this is what a future session will load to resume.

```markdown
---
assignment: <assignment-slug>
sessionId: <session-id>
created: "<original created timestamp, or now if new>"
updated: "<now, ISO 8601>"
---

# Session Summary

## Snapshot

<One paragraph: what the assignment is, where work currently stands, what is load-bearing for a future session to know immediately on resume.>

## What Was Done

- <Concrete action 1>
- <Concrete action 2>
- ...

## What's Next

- <Most important next step>
- <Subsequent steps in order>
- ...

## Open Questions

- <Unresolved question or decision>
- <Ambiguity to resolve>
- ...
(or "None." if no open items)

## Load-Bearing Context

- File paths + line numbers that matter for resume
- Command outputs the next session will need
- Decisions made this session that aren't captured in `decision-record.md`
- External references (PRs, issues, docs) that scope the next steps
```

## Step 5: Confirm — Do NOT Touch handoff.md

Verify your write did not modify `<assignmentDir>/handoff.md`. The two artifacts are deliberately separate:

| File | Scope | When written | Audience |
|------|-------|--------------|----------|
| `handoff.md` | Assignment-level | At completion (via `complete-assignment`) | Next ticket / agent / human reviewer |
| `sessions/<sid>/summary.md` | Session-scoped | Mid-assignment, on demand or pre-compact | Future session of the same agent on the same assignment |

## Step 6: Append a Progress Entry (optional but recommended)

If progress hasn't already been logged in this turn, append a brief entry to `<assignmentDir>/progress.md` noting that a session summary was saved and the next-step pointer.

## Step 7: Report to User

Summarize:
- Path of the written summary
- Session id
- Number of items in "What's Next" (so the user knows resume scope)
- Reminder: this is mid-assignment continuity, not cross-ticket handoff
