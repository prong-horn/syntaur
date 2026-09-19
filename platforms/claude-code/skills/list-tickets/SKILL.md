---
name: list-tickets
description: >-
  List Syntaur tickets across all projects with filters by stage,
  project, tag, and age. Use when the user wants to "see all tickets",
  "list backlog work", "show in_progress tickets", "what's open",
  "find tickets tagged X", or otherwise query the cross-project board
  non-interactively. Emits scriptable output (table or JSON).
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# List Tickets

Cross-project ticket listing using `syntaur ls`. Supports filters by
stage, project, tag, and age. Emits a compact aligned table by default;
`--json` produces machine-readable output suitable for piping into other
tools.

## When NOT to use this skill

- The user wants to interactively browse and act on tickets — use the
  dashboard instead.
- The user wants details for a single ticket they already know — run
  `syntaur show <id>`.
- The user wants project-level rollups (totals, blocked counts) — that's the
  dashboard, not `ls`.

## Step 1: Map user prose to filters

Common requests → flags:

- "backlog tickets" → `--status backlog`
- "in-progress" / "active" → `--status in_progress`
- "in review" → `--status review`
- "blocked tickets" → filter tickets with `blocked` flag (use `--json` and filter, or dashboard)
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

Stage ids: `backlog`, `planning`, `ready`, `in_progress`, `review`, `done`, `dropped`.

## Step 3: Present results

Default output is a table with columns: PROJECT, SLUG, STATUS, PRIORITY,
ASSIGNEE, UPDATED, TITLE. If the user asked for a count or a follow-up
action ("which one is highest priority?"), parse the table or re-run with
`--json` and pick programmatically.

## Step 4: Report to User

If interactive:

- Summarize the count and any obvious patterns (e.g. "5 backlog in
  syntaur-meta, 3 in_progress across other projects").
- Suggest a next action when applicable (e.g. "want to grab the top-priority
  backlog one?").

If scripted (`--json`), pass the parsed JSON downstream without re-rendering.
