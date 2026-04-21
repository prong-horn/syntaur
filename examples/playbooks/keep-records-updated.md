---
name: "Keep Records Updated"
slug: keep-records-updated
description: "Agents must keep assignment.md criteria, progress.md, and related records current in real-time"
when_to_use: "After every meaningful action, when completing acceptance criteria, when starting or stopping work"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-20T00:00:00Z"
tags:
  - protocol
  - recordkeeping
---

# Keep Records Updated

## After every meaningful action:
- Append a new entry to `progress.md` with what you did
- Progress entries live in `progress.md` (reverse-chronological order, newest first with a `## <ISO 8601 timestamp>` heading). Do NOT add a `## Progress` section to `assignment.md` — that section is removed as of protocol v2.0.
- Bump `entryCount` and `updated` in `progress.md`'s frontmatter.

## When you complete an acceptance criterion:
- Check it off in the `## Acceptance Criteria` section of `assignment.md` immediately
- Do not batch these up -- mark them as you go

## When you have a question, note, or piece of feedback:
- Run `syntaur comment <slug-or-uuid> "body" --type question|note|feedback [--reply-to <id>]`
- Never edit `comments.md` directly — all writes are CLI-mediated
- Questions carry a `resolved` flag that can be toggled from the dashboard

## When starting work:
- Append an entry to `progress.md` noting you've begun and what your approach is
- If any plan files exist (plan.md, plan-v2.md, ...), update their task checkboxes as you complete steps

## When stopping or handing off:
- Append a final entry to `progress.md` summarizing current state
- Write a structured handoff entry in `handoff.md`
- Note anything the next agent needs to know
