---
name: save-session-summary
description: Write a per-session continuity summary so a future session can resume this assignment cleanly
arguments:
  - name: args
    description: "(none) — the skill reads .syntaur/context.json and the current session"
    required: false
---

# /save-session-summary

Thin wrapper that invokes the `save-session-summary` skill. The skill lives in `~/.claude/skills/save-session-summary/` (installed by `syntaur setup` / `syntaur install-plugin`) and contains the full protocol — writing `<assignmentDir>/sessions/<sessionId>/summary.md` without touching `handoff.md`.

This is **mid-assignment session continuity**, not cross-ticket handoff:
- Use `/save-session-summary` when you're about to compact, when you'll resume in a new session, or when the user asks to "save the session".
- Use `/complete-assignment` (which writes `handoff.md`) when finishing the assignment for downstream review.

## Instructions

Invoke the `save-session-summary` skill via the Skill tool, passing the user's arguments. The skill handles everything else.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin` (or `syntaur setup` if they haven't set up yet).
