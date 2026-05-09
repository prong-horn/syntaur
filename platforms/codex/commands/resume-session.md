---
description: Re-orient a fresh session on the active Syntaur assignment without re-reading the full transcript
---

# /resume-session

Print a compact orientation block from the latest saved session summary, `.syntaur/context.json`, and any open handoff. Idempotent — does not mutate state.

Follow the `resume-session` skill in full. Summary:

1. Run `syntaur session resume`. Surface its output.
2. Read the latest `<assignmentDir>/sessions/<sid>/summary.md` if reported.
3. Read `<assignmentDir>/handoff.md` if present and non-placeholder (canonical single-file handoff).
4. Read `assignment.md` and the tail of `progress.md`.
5. Report active project / assignment / branch / next concrete action.
