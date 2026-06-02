---
name: views
description: >-
  Create and manage Syntaur saved views (the named, filtered board
  configurations on the dashboard's /views page) from the CLI. Use when the user
  wants to "create a view", "save a view", "add a saved view", "list views",
  "show a view", "edit/update a view", "change a view's filters", or "delete a
  view". Wraps `syntaur views`, which reads/writes the CLI-managed
  `~/.syntaur/saved-views.json` so CLI-created views are identical to ones made in
  the dashboard UI.
license: MIT
metadata:
  author: prong-horn
  version: "1.0.0"
---

# Views

Manage Syntaur saved views over their full lifecycle — create, list, show,
update, delete — via the `syntaur views` command group. A saved view is a named
board configuration: a view mode (kanban/list/table), a set of filters, a sort,
and per-surface column/section visibility. They live in
`~/.syntaur/saved-views.json` and surface on the dashboard at `/views` (or
`/w/<workspace>/views` for workspace-scoped views).

**The store is CLI-managed.** Never edit `~/.syntaur/saved-views.json` directly —
always go through `syntaur views`. The CLI reuses the exact same builder/validator
as the dashboard, so a view you create here is byte-identical (config-wise) to one
created in the UI and shows up immediately in `/views`.

## When NOT to use this skill

- The user wants the **dashboard layout** (the widget slots on the overview), not
  a saved view — that's a different surface (`PUT /api/dashboard`), not covered
  here.
- The user wants to change their default/per-session view *preferences* (density,
  grouping) rather than a persisted, named saved view — those are view-prefs, a
  separate system.
- The user wants a project/assignment — use `create-project` / `create-assignment`.

## Routing intents to subcommands

| User intent | Subcommand |
|-------------|-----------|
| "create / save / add a view" | `syntaur views add` |
| "list / show all views" | `syntaur views list` |
| "show / inspect one view" | `syntaur views show <id>` |
| "update / edit / rename / change filters" | `syntaur views update <id>` |
| "delete / remove a view" | `syntaur views delete <id>` |

Get a view's `id` from `syntaur views list` (or `list --json`).

## The config flag set (shared by `add` and `update`)

Multi-value filter flags are comma-separated. Passing `all` or `""` to a filter
clears it (values are minimized: `all`/empty/duplicates are dropped). Unset flags
on `update` leave the existing value untouched.

- `--name <name>` — view name, 1–200 chars (required on `add`).
- `--workspace <ws>` — scope to a workspace. Omit (or `--global`) for a global
  view. `--workspace` and `--global` are mutually exclusive.
- `--view-mode <kanban|list|table>` — defaults to `kanban` on `add`.
- `--sort-field <title|status|priority|assignee|dependencies|created|updated>` —
  defaults to `updated`.
- `--sort-direction <asc|desc>` — defaults to `desc`.
- Filters (comma-separated, `all`/`""` clears): `--status`, `--type`,
  `--priority`, `--assignee`, `--project-filter`, `--tags`.
- `--activity <all|stale|fresh>` — `all` clears.
- Date range: `--date-range-field <created|updated>` plus EITHER
  `--date-range-preset <last_24h|last_7d|last_30d|last_90d|older_7d|older_30d>`
  OR `--date-from <YYYY-MM-DD>` / `--date-to <YYYY-MM-DD>`. Use
  `--clear-date-range` to remove it.
- `--search <text>` — free-text filter (`""` clears).
- Visibility: `--collapsed <ids>` (list sections), `--kanban-hidden <ids>`,
  `--table-hidden <title|status|priority|assignee|dependencies|created|updated>`.
- `--json` — print the resulting view as JSON instead of a summary line.

## Step 1: Resolve scope (workspace)

If the user wants the view scoped to a workspace, pass `--workspace <ws>`.
Otherwise it is global. If `.syntaur/context.json` implies a workspace and the
user said "in this workspace", use that; when unsure, default to global and
mention it.

## Step 2: Create a view

```bash
syntaur views add \
  --name "<name>" \
  [--workspace <ws> | --global] \
  [--view-mode <kanban|list|table>] \
  [--status <a,b>] [--priority <a,b>] [--type <a,b>] \
  [--assignee <a,b>] [--project-filter <a,b>] [--tags <a,b>] \
  [--activity <all|stale|fresh>] \
  [--date-range-field <created|updated> --date-range-preset <preset> | --date-from <YYYY-MM-DD> --date-to <YYYY-MM-DD>] \
  [--search "<text>"] \
  [--sort-field <field>] [--sort-direction <asc|desc>] \
  [--json]
```

Prints `Created view <id> ("<name>")` (or the JSON view with `--json`). Capture
the `id`.

## Step 3: List / show

```bash
syntaur views list                # plain: <id>  <name>  [workspace]  <viewMode>
syntaur views list --json         # full views array
syntaur views show <id>           # readable id/name/workspace/config
syntaur views show <id> --json    # the raw view object
```

## Step 4: Update a view

Pass only the flags you want to change; everything else is preserved. To rename,
pass `--name`. To clear a filter, pass it as `all` or `""`. At least one of
`--name`, `--workspace`/`--global`, or a config flag is required.

```bash
syntaur views update <id> --priority high --sort-field created   # change
syntaur views update <id> --status all                           # clear status
syntaur views update <id> --clear-date-range                     # drop date range
syntaur views update <id> --name "Renamed"                       # rename
```

## Step 5: Delete a view

```bash
syntaur views delete <id>
```

Removes the view and nulls any dashboard widget slot that referenced it.

## Step 6: Report to User

Summarize:

- The action taken and the view `id` + name.
- For create/update, the resulting scope (workspace or global) and key filters.
- That the change is live in the dashboard `/views` page immediately.
