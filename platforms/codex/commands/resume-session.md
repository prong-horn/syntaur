---
description: Re-orient a fresh session on the active Syntaur ticket without re-reading the full transcript
---

# /resume-session

Print a compact orientation block from `.syntaur/context.json` and any open handoff. Idempotent — does not mutate state.

Follow the `resume-session` skill in full. Summary:

1. Run `syntaur session resume`. Surface its output.
2. Read the latest `handoff` log entry (or legacy handoff file when present).
3. Read `ticket.md` and the tail of `progress.md`.
4. Report active project / ticket / branch / next concrete action.
