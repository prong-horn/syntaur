---
name: complete-assignment
description: Write a handoff and transition the current Syntaur assignment to review or completed
argument-hint: "[--complete]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
---

# Complete Assignment

Write a handoff for your current assignment and transition it to review (or completed).

## Arguments

User provided: $ARGUMENTS

If the user passed `--complete`, transition directly to `completed` instead of `review`. However, `--complete` is ONLY allowed if ALL acceptance criteria are met. If any criteria are unmet, always transition to `review` regardless of the `--complete` flag, and inform the user why.

## Step 1: Load Context

Read `.syntaur/context.json` from the current working directory.

If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <mission-slug>` first."

Extract: `missionSlug`, `assignmentSlug`, `assignmentDir`, `missionDir`.

## Step 1.5: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/` — verify your work complies with their rules:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each file found, read it and check that your work follows its directives. If any playbook has completion-related rules (e.g., "run tests before done"), follow them before proceeding.

## Step 2: Verify Acceptance Criteria

Read `<assignmentDir>/assignment.md` and find the `## Acceptance Criteria` section.

Review each criterion (checkbox item). For each:
- If you believe it is met, note why (what was implemented, where)
- If it is NOT met, flag it clearly

If any criteria are not met, warn the user: "The following acceptance criteria are not yet met: [list]. Do you want to proceed with the handoff anyway?"

If the user says no, stop.

## Step 3: Write Handoff Entry

Read `<assignmentDir>/handoff.md` to see its current content and frontmatter.

Append a new handoff entry to the markdown body. Read the current `handoffCount` from the frontmatter and use `handoffCount + 1` as the entry number. The entry MUST follow the protocol-specified format from `docs/protocol/file-formats.md`:

```markdown
---
## Handoff <N>: <ISO 8601 timestamp>

**From:** claude
**To:** human
**Reason:** <Why this handoff is happening, e.g., "Assignment complete, handing off for review.">

### Summary
<One paragraph summarizing what was accomplished and what remains>

### Current State
- <What is working>
- <What is not working or partially done>
- <Acceptance criteria status: N of M met>

### Next Steps
- <Recommended next actions for the reviewer or next agent>

### Important Context
- <Anything the next agent/human needs that is not in the assignment or plan>
```

Use the Edit tool to append this entry to handoff.md (do not overwrite existing content).

Also update the handoff.md frontmatter: set `updated` to the current timestamp and increment the `handoffCount` by 1.

## Step 4: Update Acceptance Criteria Checkboxes

In `<assignmentDir>/assignment.md`, update the acceptance criteria checkboxes to reflect the current state. Use the Edit tool to check off criteria that were met (change `- [ ]` to `- [x]`).

**Note:** Ideally, criteria should have been checked off incrementally during implementation. If they are already checked, verify they are still accurate. If some were missed, check them off now with a note in the handoff about which were verified at completion time vs. during development.

## Step 4.5: Close Session

Read the context file (`.syntaur/context.json`) to get the `sessionId` and `missionSlug`. Then mark the session as completed via the dashboard API:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "missionSlug": "<mission-slug>"}'
```

If the API call fails (e.g., dashboard not running), this is non-critical — the session will be reconciled automatically on the next dashboard load.

## Step 5: Transition Assignment State

If the user passed `--complete`:

```bash
syntaur complete <assignment-slug> --mission <mission-slug>
```

Otherwise, transition to review:

```bash
syntaur review <assignment-slug> --mission <mission-slug>
```

Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/`.

If the command fails, report the error. Common failures:
- Assignment is not in `in_progress` status (cannot transition)
- Mission not found

## Step 6: Clean Up Context

Delete the context file:

```bash
rm .syntaur/context.json
```

## Step 7: Report to User

Summarize:
- Assignment slug and title
- New status (review or completed)
- Number of acceptance criteria met vs total
- Remind: if transitioned to `review`, a human reviewer will check the work. If any criteria were unmet, they may send it back to `in_progress` via `syntaur start`.
