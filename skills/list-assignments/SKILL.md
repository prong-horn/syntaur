---
name: list-assignments
description: >-
  List Syntaur assignments across all projects with filters by status,
  project, tag, and age. Use when the user wants to "see all assignments",
  "list pending work", "show in_progress assignments", "what's open",
  "find assignments tagged X", or otherwise query the cross-project board
  non-interactively. Different from the interactive `browse` TUI — emits
  scriptable output (table or JSON).
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# List Assignments

Cross-project assignment listing using `syntaur ls`. Supports filters by
status, project, tag, and age. Emits a compact aligned table by default;
`--json` produces machine-readable output suitable for piping into other
tools.

## When NOT to use this skill

- The user wants to interactively browse and act on assignments — use
  `syntaur browse` (the Ink TUI) instead.
- The user wants details for a single assignment they already know — open
  its `assignment.md` directly.
- The user wants project-level rollups (totals, blocked counts) — that's the
  dashboard, not `ls`.

## Step 1: Map user prose to filters

Common requests → flags:

- "pending assignments" → `--status pending`
- "in-progress" / "active" → `--status in_progress`
- "stuff blocked" → `--status blocked`
- "everything in <project>" → `--project <slug>`
- "tagged with X" / "labeled X" → `--tag X`
- "must have all of X and Y" → `--tag X,Y` (AND semantics)
- "from this week" → `--age 7d`
- "last 24 hours" → `--age 24h`
- "this month" → `--age 30d` (or `1m`)
- "as JSON" / "for piping" → `--json`

Multiple filters compose (intersected).

## Step 2: Run `syntaur ls`

```bash
syntaur ls [--status <list>] [--project <slug>] [--tag <list>] [--age <duration>] [--json]
```

Supported `--age` units: `h` (hours), `d` (days), `w` (weeks), `m` (~30 days).

## Step 3: Present results

Default output is a table with columns: PROJECT, SLUG, STATUS, PRIORITY,
ASSIGNEE, UPDATED, TITLE. If the user asked for a count or a follow-up
action ("which one is highest priority?"), parse the table or re-run with
`--json` and pick programmatically.

## Step 4: Report to User

If interactive:

- Summarize the count and any obvious patterns (e.g. "5 pending in
  syntaur-meta, 3 blocked across other projects").
- Suggest a next action when applicable (e.g. "want to grab the top-priority
  pending one?").

If scripted (`--json`), pass the parsed JSON downstream without re-rendering.
