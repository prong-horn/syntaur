---
name: complete-assignment
description: Use when the user wants to write a Syntaur handoff, close the current session, and transition the assignment to review or completed.
---

# Complete Assignment

Write a handoff for the current Syntaur assignment and transition it to `review` or `completed`.

## Arguments

User arguments: `$ARGUMENTS`

If the user passed `--complete`, transition directly to `completed` only when all acceptance criteria are met AND all todos are either checked or marked superseded. Otherwise transition to `review`.

## Workflow

1. Read `.syntaur/context.json`. If it does not exist, tell the user there is no active assignment.
2. Read `<assignmentDir>/assignment.md` and evaluate every item in the `## Acceptance Criteria` section AND every item in the `## Todos` section. Superseded todos (marked `- [x] ~~...~~ (superseded by ...)`) count as resolved. If any acceptance criterion is unmet OR any todo is still `- [ ]` and not superseded, warn the user before proceeding.
2.5. Append a final entry to `<assignmentDir>/progress.md` (reverse-chron, newest first) under a new `## <ISO 8601 timestamp>` heading summarizing the final state of the work. Bump `entryCount` and `updated` in the frontmatter. Do NOT add a `## Progress` section to `assignment.md` — progress entries live exclusively in `progress.md` as of protocol v2.0.
3. Read `<assignmentDir>/handoff.md` and append a new handoff entry using the protocol format:

```markdown
## Handoff <N>: <ISO 8601 timestamp>

**From:** codex
**To:** human
**Reason:** <Why this handoff is happening>

### Summary
<One paragraph>

### Current State
- <What is working>
- <What is not working or still partial>
- <Acceptance criteria status: N of M met>

### Next Steps
- <Recommended follow-up actions>

### Important Context
- <Anything the next person needs to know>
```

4. Update the handoff frontmatter:
   - set `updated` to the current timestamp
   - increment `handoffCount`
5. Update acceptance criteria and todo checkboxes in `assignment.md` to match reality. Do NOT modify superseded todo lines (those matching `- [x] ~~...~~ (superseded by ...)`).
6. If `.syntaur/context.json` includes `sessionId`, mark that session as completed through the dashboard API:

```bash
curl -s -X PATCH "http://localhost:$(cat ~/.syntaur/dashboard-port 2>/dev/null || echo 4800)/api/agent-sessions/<session-id>/status" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","projectSlug":"<project-slug>"}'
```

7. Transition the assignment:
   - `syntaur complete <assignment-slug> --project <project-slug>` when `--complete` is allowed
   - otherwise `syntaur review <assignment-slug> --project <project-slug>`
8. Delete `.syntaur/context.json`.
9. Summarize:
   - new status
   - acceptance criteria met vs total
   - any criteria still unmet or follow-up risk
