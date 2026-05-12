---
name: log-progress
description: Append a timestamped entry to the active assignment's progress.md and bump frontmatter (Keep Records Updated playbook)
arguments:
  - name: args
    description: "Optional one-line summary. The skill prompts for a body if no args given."
    required: false
---

# /log-progress

Thin wrapper that invokes the `log-progress` skill via the Skill tool. Markdown-only — no CLI verb. Appends a structured timestamped entry to `<assignmentDir>/progress.md` and bumps `entryCount` + `updated`.

Arguments: $ARGUMENTS

If the skill is not installed, tell the user to run `syntaur install-plugin`.
