---
name: log-progress
description: >-
  Append a timestamped entry to the active assignment's `progress.md`,
  bumping `entryCount` and `updated` in its frontmatter. Use after every
  meaningful action — completing an acceptance criterion, finishing a plan
  task, hitting a blocker, deciding on an approach — per the Keep Records
  Updated playbook. Triggers on "log progress", "note progress", "record
  this in progress", or whenever the playbook says to update records.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Log Progress

Append a structured timestamped entry to the active assignment's
`<assignmentDir>/progress.md`, and update its frontmatter. Markdown-only —
no CLI verb. Idempotent in the sense that re-running with the same body
produces a duplicate entry, which is intentional (timestamps differ).

This skill implements the **Keep Records Updated** playbook: agents must keep
records current in real-time, especially after every meaningful action.

## When NOT to use this skill

- The action belongs in `decision-record.md` (architecturally significant
  decisions with rationale) — write to that file, not progress.md.
- The information is for the next session of the SAME assignment — that's
  `/save-session-summary`.
- The information is a question for the user — write to `comments.md` via
  `syntaur comment` (CLI-mediated).
- The information is a follow-up assignment idea — open a new assignment
  via `/create-assignment`.

## Step 1: Verify there is an active assignment

Read `.syntaur/context.json` from the current working directory. Extract
`assignmentDir`. If missing, abort with: "No active assignment. Run
`grab-assignment` first."

## Step 2: Compose the entry

The entry should be concise, factual, and link-rich. Suggested structure:

```markdown
## <ISO 8601 UTC timestamp> — <one-line summary>

- What changed (action verbs).
- Files touched: `path/to/file.ts:line`, `another.ts`.
- Commits: `<short-sha>` (one per logical change).
- Verification: `npm test src/...`, `node dist/index.js x --help`, etc.

Optional notes paragraph.
```

Use ISO 8601 with `Z` suffix (e.g. `2026-05-08T20:13:00Z`). Use absolute
file paths or repo-relative paths consistently.

## Step 3: Read existing progress.md

Read `<assignmentDir>/progress.md`. Extract:

- Current `entryCount` from the frontmatter.
- The full body (everything after the second `---`).

If `progress.md` doesn't exist, abort and tell the user to re-grab the
assignment (the file should always exist for an in-progress assignment).

## Step 4: Compute new frontmatter

- `entryCount`: increment by 1.
- `updated`: set to current ISO timestamp.
- Other fields (`assignment`, `generated`): preserve as-is.

## Step 5: Write the file

Write back the file with the updated frontmatter, the existing body, and the
new entry appended at the end (with one blank line between the prior content
and the new entry). Use `cat <<EOF >>` semantics OR rewrite the whole file
— either is fine as long as the final content is correct.

If the existing body is the placeholder text "No progress yet.", replace it
with the new entry instead of appending after it.

## Step 6: Verify schema

Confirm by re-reading the file:

- Starts with `---`, then frontmatter, then `---`.
- `entryCount` is a non-negative integer.
- `updated` matches the timestamp you wrote.
- The new entry's `## <timestamp>` heading is present.

If the file fails schema check, restore the prior content and report the
error — do not leave it partially written.

## Step 7: Report to User

Summarize:

- Path of the modified `progress.md`.
- New `entryCount`.
- One-line summary of the entry that was logged.
