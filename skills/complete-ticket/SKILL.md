---
name: complete-ticket
description: >-
  Write a handoff and transition the current Syntaur ticket to review or completed.
  Use when the user wants to finish an ticket, write a handoff, or submit work for review.
license: MIT
metadata:
  author: prong-horn
  version: "1.2.0"
---

# Complete Ticket

Write a handoff for your current Syntaur ticket and transition it to `review` or `completed`.

## Input

Optional: the user may pass `--complete` to transition directly to `completed` instead of `review`. However, `--complete` is only allowed if ALL acceptance criteria are met. If any criterion is unresolved, always transition to `review` regardless of the flag, and inform the user why.

## Step 1: Load Context

The active ticket is resolved from the session's open engagement. Run `syntaur session resume --json` to read it.

If there is no open engagement (no active ticket), tell the user: "No active ticket for this session — grab one first." `.syntaur/context.json` is only a workspace marker; do not read the ticket from it.

From the resolved engagement, note: `projectSlug`, `ticketSlug`, `ticketDir`, `projectDir`.

## Step 2: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/`:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

Verify your work complies with their rules. If any playbook has completion-related rules (e.g., "run tests before done"), follow them before proceeding.

## Step 3: Verify Acceptance Criteria

Read `<ticketDir>/ticket.md` and find the `## Acceptance Criteria` section.

Review each acceptance criterion (checkbox item). For each:
- If you believe it is met, note why (what was implemented, where).
- If it is NOT met, flag it clearly.

If any acceptance criteria are unmet, warn the user: "The following tre not yet done: [list]. Do you want to proceed with the handoff anyway?" — stop if the user says no.

## Step 3.5: Append a Final Progress Entry

Before writing the handoff, append a final entry to `<ticketDir>/progress.md` summarizing what was completed. The entry goes at the **top** of the body (reverse-chronological) under a new `## <ISO 8601 timestamp>` heading:

```markdown
## <ISO 8601 timestamp>

<One paragraph summarizing the final state of work: what was implemented, what verifications passed, and any deliberate scope exclusions.>
```

Bump `entryCount` and set `updated` to the current timestamp in `progress.md`'s frontmatter.

Do NOT add a `## Progress` section to `ticket.md` — progress entries live exclusively in `progress.md` as of protocol v2.0.

## Step 4: Write Handoff Entry

Read `<ticketDir>/handoff.md` to see its current content and frontmatter.

Append a new handoff entry to the markdown body. Read the current `handoffCount` from the frontmatter and use `handoffCount + 1` as the entry number. The entry must follow this format:

```markdown
## Handoff <N>: <ISO 8601 timestamp>

**From:** <your-agent-name>
**To:** human
**Reason:** <Why this handoff is happening, e.g., "Ticket complete, handing off for review.">

### Summary
<One paragraph summarizing what was accomplished and what remains>

### Current State
- <What is working>
- <What is not working or partially done>
- <Acceptance criteria status: N of M met>

### Next Steps
- <Recommended next actions for the reviewer or next agent>

### Important Context
- <Anything the next agent/human needs that is not in the ticket or plan>
```

Also update the handoff.md frontmatter: set `updated` to the current timestamp and increment the `handoffCount` by 1.

## Step 5: Update Acceptance Criteria Checkboxes

In `<ticketDir>/ticket.md`, update checkboxes in the `## Acceptance Criteria` section to reflect the current state. Check off items that were completed (change `- [ ]` to `- [x]`).

Ideally, these should have been checked off incrementally during implementation. If they are already checked, verify they are still accurate. If some were missed, check them off now and note which were verified at completion time vs. during development in the handoff.

## Step 6: Close Session (optional)

If the Syntaur dashboard is running, mark this session as completed. Resolve `<session-id>` from *your* running process — prefer `$CLAUDE_CODE_SESSION_ID` (or the peer `OPENCODE_SESSION_ID` / `PI_SESSION_ID`), otherwise run `syntaur session resolve-id`; fall back to the `sessionId` scalar in `.syntaur/context.json` only as a last resort (it is a shared, legacy hint a co-tenant can clobber, not authoritative):

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","projectSlug":"<project-slug>"}'
```

If this fails (e.g., dashboard not running), it is non-critical — the session will be reconciled automatically.

## Step 7: Transition Ticket State

If the user requested `--complete` and all criteria are met:

```bash
syntaur complete <ticket-slug> --project <project-slug>
```

Otherwise, transition to review:

```bash
syntaur review <ticket-slug> --project <project-slug>
```

If the command fails, report the error. Common failures:
- Ticket is not in `in_progress` status
- Project not found

## Step 8: Clean Up Context

Delete the context file:

```bash
rm .syntaur/context.json
```

## Step 9: Report to User

Summarize:
- Ticket slug tnd title
- New status (review or completed)
- Number of acceptance criteria met vs total
- If transitioned to `review`, a human reviewer will check the work. If any criteria were unmet, they may send it back to `in_progress`.
