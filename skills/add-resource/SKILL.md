---
name: add-resource
description: >-
  Register a project-level resource (link to a dashboard, doc, ticket, or
  external system) under a Syntaur project. Use when the user wants to "add a
  resource", "save this link to the project", "track this dashboard", "add a
  reference doc", or otherwise capture a pointer to an external system the
  project depends on.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Add Resource

Add a resource entry to a Syntaur project. Writes
`<projectDir>/resources/<slug>.md` and regenerates `<projectDir>/resources/_index.md`
via the CLI — the agent never edits `_index.md` directly (it is a
CLI-managed file per the file-ownership protocol).

## When NOT to use this skill

- The information is **session-scoped knowledge**, not a pointer to an
  external system — use `add-memory` instead.
- The link is specific to a single assignment (assignment-level scratch) —
  put it in that assignment's `scratchpad.md`.
- The resource already exists. Read `<projectDir>/resources/_index.md` first
  to check; pass `--force` only if you intend to overwrite.

## Step 1: Resolve project

If the session has an open engagement with an active assignment (`syntaur
session resume --json`), default to its `projectSlug`. Otherwise ask the user
which project to add the resource to.

## Step 2: Gather inputs

Required:

- `--name <human readable>` — display name for the resource.
- `--source <url-or-path>` — the link or path to the resource itself.

Optional:

- `--category <name>` — short category tag (e.g. `dashboard`, `doc`,
  `ticket`, `runbook`, `repo`).
- `--related-assignments <slug,slug,...>` — comma-separated assignment slugs
  this resource is relevant to.
- `--slug <slug>` — override the auto-generated kebab-case slug.

## Step 3: Run `syntaur resource add`

```bash
syntaur resource add \
  --project <project-slug> \
  --name "<name>" \
  --source <url-or-path> \
  [--category <name>] \
  [--related-assignments <slug,slug>] \
  [--slug <slug>] \
  [--force]
```

The CLI:

1. Validates the project exists.
2. Writes `<projectDir>/resources/<slug>.md` with the canonical frontmatter
   (`name`, `category`, `source`, `relatedAssignments`, `created`,
   `updated`).
3. Regenerates `<projectDir>/resources/_index.md` from the directory contents.
4. Refuses to overwrite an existing resource without `--force`.

## Step 4: Verify

The CLI prints the slug file path and the new index size. Read both back if
the user asked for confirmation.

## Step 5: Report to User

Summarize:

- Resource slug and absolute path.
- Project that received the resource.
- Index regenerated (with the new total).
- Suggested next step: open the dashboard or `_index.md` to see the new entry.
