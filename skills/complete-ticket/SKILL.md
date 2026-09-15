---
name: complete-ticket
description: >-
  Log a handoff and transition the current Syntaur ticket to review or done.
  Use when the user wants to finish a ticket, write a handoff, or submit work for review.
license: MIT
metadata:
  author: prong-horn
  version: "1.3.0"
---

# Complete Ticket

Log a handoff for your current Syntaur ticket and transition it to `review` or `done` via lifecycle verbs.

## Input

Optional: the user may pass `--done` to transition directly to `done` instead of `review`. However, `--done` is only allowed if ALL acceptance criteria are met and template gates pass. If any criterion is unresolved, always transition to `review` regardless of the flag, and inform the user why.

## Step 1: Load Context

The active ticket is resolved from the session's open engagement. Run `syntaur session resume --json` to read it.

If there is no open engagement (no active ticket), tell the user: "No active ticket for this session — grab one first." `.syntaur/context.json` is only a workspace marker; do not read the ticket from it.

From the resolved engagement, note: `projectSlug`, `ticketSlug`, `ticketDir`, `projectDir`.

Run `syntaur show` to discover the template's log-role file and current **Next** hint.

## Step 2: Follow stage instructions

Run `syntaur show` and follow **Stage** and **Next**. The review and done stage
instructions require verifying acceptance criteria, tests, and build before
handoff; cross-template playbooks injected by the prompt hook apply on top when
enabled.

## Step 3: Verify Acceptance Criteria

Read `<ticketDir>/ticket.md` and find the `## Acceptance Criteria` section.

Review each acceptance criterion (checkbox item). For each:
- If you believe it is met, note why (what was implemented, where).
- If it is NOT met, flag it clearly.

If any acceptance criteria are unmet, warn the user: "The following are not yet done: [list]. Do you want to proceed with the handoff anyway?" — stop if the user says no.

## Step 3.5: Append a Final Progress Entry

Append a final log entry via the CLI (never edit the log file directly):

```bash
syntaur log <ticket-id> -t progress "..." [--project <project-slug>]
```

Or use `syntaur progress log` if that is what `show` lists in **Commands**.

## Step 4: Write Handoff Entry

Append a handoff via the log role:

```bash
syntaur log <ticket-id> -t handoff "..." [--project <project-slug>]
```

The body should summarize what was accomplished, current state, next steps, and important context for the reviewer.

Legacy templates may still list separate `handoff.md` until `migrate journal` — follow `syntaur show` for the writer role on that path.

## Step 5: Update Acceptance Criteria Checkboxes

In `<ticketDir>/ticket.md`, update checkboxes in the `## Acceptance Criteria` section to reflect the current state. Check off items that were completed (change `- [ ]` to `- [x]`).

## Step 6: Close Session (optional)

If the Syntaur dashboard is running, mark this session as completed. Resolve `<session-id>` from *your* running process — prefer `$CLAUDE_CODE_SESSION_ID` (or the peer `OPENCODE_SESSION_ID` / `PI_SESSION_ID`), otherwise run `syntaur session resolve-id`; fall back to the `sessionId` scalar in `.syntaur/context.json` only as a last resort:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","projectSlug":"<project-slug>"}'
```

If this fails (e.g., dashboard not running), it is non-critical.

## Step 7: Transition Ticket State

If the user requested `--done` and all criteria are met:

```bash
syntaur done <ticket-id> --project <project-slug>
```

Otherwise, transition to review:

```bash
syntaur review <ticket-id> --project <project-slug>
```

If the command fails, report the error and the **Next** hint from `syntaur show`. Common failures: wrong stage, unmet gate.

## Step 8: Clean Up Context

Delete the context file:

```bash
rm .syntaur/context.json
```

## Step 9: Report to User

Summarize:
- Ticket id and title
- New stage (`review` or `done`)
- Number of acceptance criteria met vs total
- If transitioned to `review`, a human reviewer will check the work. They may run `syntaur done` or `syntaur reopen`.
