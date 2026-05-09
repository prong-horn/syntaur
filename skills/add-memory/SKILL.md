---
name: add-memory
description: >-
  Capture a project-level Syntaur memory (durable context like a convention,
  decision rationale, or constraint) under a project's `memories/` directory.
  Use when the user wants to "save this to memory", "remember for the project",
  "capture this decision", "add a project memory", or pin reusable context that
  should outlive any single assignment. Writes via the CLI so the
  CLI-managed `_index.md` is never touched directly.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Add Memory

Add a memory entry to a Syntaur project. Writes
`<projectDir>/memories/<slug>.md` and regenerates `_index.md` server-side via
`syntaur memory add` — the agent never edits `_index.md` directly per the
file-ownership protocol.

## When NOT to use this skill

- The information is a **pointer to an external system** (URL, dashboard,
  ticket) — use `add-resource` instead.
- The information is the user-global Claude Code memory at
  `~/.claude/projects/<...>/memory/MEMORY.md` — that's a different system
  managed by the auto-memory feature, NOT Syntaur project memories.
- The information is single-assignment scratch — put it in the assignment's
  `scratchpad.md`.

## Step 1: Resolve project

If `.syntaur/context.json` is present and has `projectSlug`, default to that.
Otherwise ask the user which project to add the memory to.

## Step 2: Gather inputs

Required:

- `--name <human readable>` — display name for the memory.
- `--source <text>` — where this memory came from (e.g. "conversation
  2026-05-08", a decision-record reference, a doc URL).

Optional:

- `--scope <scope>` — defaults to `project`. Common values: `project`,
  `architecture`, `policy`.
- `--source-assignment <slug>` — assignment slug this memory was captured
  during (helps trace the origin).
- `--related-assignments <slug,slug,...>` — comma-separated assignment slugs
  this memory is relevant to.
- `--slug <slug>` — override the auto-generated kebab-case slug.

## Step 3: Run `syntaur memory add`

```bash
syntaur memory add \
  --project <project-slug> \
  --name "<name>" \
  --source "<text>" \
  [--scope <scope>] \
  [--source-assignment <slug>] \
  [--related-assignments <slug,slug>] \
  [--slug <slug>] \
  [--force]
```

The CLI:

1. Validates the project exists.
2. Writes `<projectDir>/memories/<slug>.md` with the canonical frontmatter
   (`name`, `source`, `scope`, `sourceAssignment`, `relatedAssignments`,
   `created`, `updated`).
3. Regenerates `<projectDir>/memories/_index.md` from the directory contents.
4. Refuses to overwrite an existing memory without `--force`.

**Do not write to `_index.md` directly under any circumstances** — that file
is owned by the CLI per the file-ownership protocol.

## Step 4: Open the new memory file (optional)

If the user wants to flesh out the body content beyond the placeholder, open
`<projectDir>/memories/<slug>.md` and edit the body. The frontmatter is
already correct; only edit content below the second `---`.

## Step 5: Report to User

Summarize:

- Memory slug and absolute path.
- Project that received the memory.
- Index regenerated (with the new total).
- Suggested next step: edit the body to capture load-bearing context, or
  open the dashboard to see the new entry.
