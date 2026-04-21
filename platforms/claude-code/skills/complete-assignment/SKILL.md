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

If the user passed `--complete`, transition directly to `completed` instead of `review`. However, `--complete` is ONLY allowed if ALL acceptance criteria are met AND every `## Todos` item is either checked or marked superseded. If any criterion or todo is unresolved, always transition to `review` regardless of the `--complete` flag, and inform the user why.

## Step 1: Load Context

Read `.syntaur/context.json` from the current working directory.

If the file does not exist, tell the user: "No active assignment found. Run `/grab-assignment <project-slug>` first."

Extract: `projectSlug`, `assignmentSlug`, `assignmentDir`, `projectDir`.

## Step 1.5: Load Playbooks

Read all playbook files from `~/.syntaur/playbooks/` — verify your work complies with their rules:

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

For each file found, read it and check that your work follows its directives. If any playbook has completion-related rules (e.g., "run tests before done"), follow them before proceeding.

## Step 2: Verify Acceptance Criteria and Todos

Read `<assignmentDir>/assignment.md` and find the `## Acceptance Criteria` and `## Todos` sections.

Review each acceptance criterion (checkbox item) and each todo. For each:
- If you believe it is met/done, note why (what was implemented, where)
- If it is NOT met/done, flag it clearly

Superseded todos (marked `- [x] ~~...~~ (superseded by ...)`) count as resolved — they do not need to be done again.

If any acceptance criteria are unmet OR any todo is still `- [ ]` and not superseded, warn the user: "The following are not yet done: [list]. Do you want to proceed with the handoff anyway?"

If the user says no, stop.

## Step 2.5: Append a Final Progress Entry

Before writing the handoff, append a final entry to `<assignmentDir>/progress.md` summarizing what was completed. The entry goes at the **top** of the body (reverse-chron order) under a new `## <RFC 3339 timestamp>` heading:

```markdown
## <ISO 8601 timestamp>

<One paragraph summarizing the final state of work: what was implemented, what verifications passed, and any deliberate scope exclusions.>
```

Update `progress.md`'s frontmatter: bump `entryCount` and set `updated` to the current timestamp.

Do NOT add a `## Progress` section to `assignment.md` — progress entries live exclusively in `progress.md` as of protocol v2.0.

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

## Step 4: Update Checkboxes (Criteria + Todos)

In `<assignmentDir>/assignment.md`, update checkboxes in both the `## Acceptance Criteria` and `## Todos` sections to reflect the current state. Use the Edit tool to check off items that were completed (change `- [ ]` to `- [x]`).

**Note:** Ideally, these should have been checked off incrementally during implementation. If they are already checked, verify they are still accurate. If some were missed, check them off now with a note in the handoff about which were verified at completion time vs. during development.

Do NOT uncheck or rewrite superseded todo lines (those matching `- [x] ~~...~~ (superseded by ...)`) — leave that history intact.

## Step 4.5: Close Session

Read the context file (`.syntaur/context.json`) to get the `sessionId` and `projectSlug`. Then mark the session as completed via the dashboard API:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status": "completed", "projectSlug": "<project-slug>"}'
```

If the API call fails (e.g., dashboard not running), this is non-critical — the session will be reconciled automatically on the next dashboard load.

## Step 5: Transition Assignment State

If the user passed `--complete`:

```bash
syntaur complete <assignment-slug> --project <project-slug>
```

Otherwise, transition to review:

```bash
syntaur review <assignment-slug> --project <project-slug>
```

Use `dangerouslyDisableSandbox: true` since the CLI writes to `~/.syntaur/`.

If the command fails, report the error. Common failures:
- Assignment is not in `in_progress` status (cannot transition)
- Project not found

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
