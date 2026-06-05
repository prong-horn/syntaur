---
description: Write a per-session continuity summary so a future Codex session can resume this assignment cleanly
---

# /save-session-summary

Write a per-session continuity summary at `<assignmentDir>/sessions/<sessionId>/summary.md` so a future session can resume this assignment without re-reading the full transcript.

This is **mid-assignment session continuity**, not cross-ticket handoff:
- Use `/save-session-summary` when about to compact, before ending a session, or when the user asks to "save the session".
- Use the `complete-assignment` skill (which writes `handoff.md`) when finishing the assignment for downstream review.

Codex has no `PreCompact` hook event — invoke this command manually.

## Workflow

Follow the `save-session-summary` skill in full. Summary:

1. Read `.syntaur/context.json`. Required: `assignmentDir`. Do NOT read the session id from this file for identity — that scalar is a shared, legacy hint a co-tenant sharing this workspace can clobber. Resolve the session id from *your* running process: prefer `$CLAUDE_CODE_SESSION_ID` (or the peer `OPENCODE_SESSION_ID` / `PI_SESSION_ID`), otherwise omit `--session-id` and let `syntaur session save` resolve it (env → process tree → transcript, falling back to the context.json hint only as a last resort). Do not synthesize a session id.
2. Create `<assignmentDir>/sessions/<sessionId>/` only at write time (avoid empty dirs).
3. Write or overwrite `<assignmentDir>/sessions/<sessionId>/summary.md` with frontmatter (`assignment`, `sessionId`, `created`, `updated`) and body sections: `## Snapshot`, `## What Was Done`, `## What's Next`, `## Open Questions`, `## Load-Bearing Context`. Single document per session id — directory partitions by session.
4. Do NOT modify `handoff.md`.
5. Optionally append a brief progress entry noting the save.
