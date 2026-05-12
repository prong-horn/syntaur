---
description: Append a timestamped entry to the active assignment's progress.md and bump frontmatter
---

# /log-progress

Append a structured timestamped entry to `<assignmentDir>/progress.md` and bump its `entryCount` and `updated` frontmatter fields. Implements the Keep Records Updated playbook.

Follow the `log-progress` skill in full. Summary:

1. Read `.syntaur/context.json`. Abort if no active assignment.
2. Compose a concise entry with action verbs, file paths, commit refs, and verification commands.
3. Read the existing `progress.md`, increment `entryCount`, set `updated = now`, append the new entry under the existing body.
4. Re-read to confirm schema-valid frontmatter; restore on schema failure.
