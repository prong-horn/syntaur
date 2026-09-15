---
name: "Keep Records Updated"
slug: keep-records-updated
description: "Agents must keep ticket.md criteria and the ticket journal current in real-time"
when_to_use: "After every meaningful action, when completing acceptance criteria, when starting or stopping work"
created: "2026-04-02T00:00:00Z"
updated: "2026-05-08T00:00:00Z"
tags:
  - protocol
  - recordkeeping
---

# Keep Records Updated

## After every meaningful action

- Append a typed entry with `syntaur log <ticket-id> -t progress "<body>" [--project <slug>]`.
- On modern templates the log role is `journal.md` (oldest-first append-only entries). On the `legacy` template the CLI still writes `progress.md`.
- Never edit the log file directly — all writes are CLI-mediated.
- Run `syntaur show` to confirm the log path and **Commands** line.

## When you complete an acceptance criterion

- Check it off in the `## Acceptance Criteria` section of `ticket.md` immediately.
- Do not batch these up — mark them as you go.

## When you have a question, note, or piece of feedback

- Questions: `syntaur log <ticket-id> -t question "<body>" [--project <slug>]`.
- Notes: `syntaur log <ticket-id> -t note "<body>"`.
- Answers (when a question is resolved): `syntaur log <ticket-id> -t answer --answers <question-ts> "<body>"`.
- Open questions surface in the inbox and on the ticket **Journal** tab.

## When starting work

- Log a `progress` entry noting you've begun and your approach.
- If any plan files exist (`plan.md`, `plan-v2.md`, …), update their task checkboxes as you complete steps.

## When stopping or handing off

- Log a final `progress` entry summarizing current state.
- Pass the baton with `syntaur log <ticket-id> -t handoff "<body>"` (see `complete-ticket` for the full handoff workflow).
- Note anything the next agent needs to know.

## Related skills

- `log-progress` — append `progress` entries after meaningful work.
- `complete-ticket` — handoff and completion semantics.
