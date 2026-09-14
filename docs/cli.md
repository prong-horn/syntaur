# Syntaur CLI

Reference for `syntaur` subcommands. Run `syntaur --help` for a full list.

## `syntaur status`

Manage the ticket-status workflow — the `statuses:` block in `~/.syntaur/config.md` that the dashboard Settings page also edits. The runtime is **all-or-nothing**: once a `statuses:` block exists the built-in defaults are no longer merged. Every mutating verb accepts `--dry-run` to print a unified diff of the would-be `statuses:` block (and, for `rename`, per-file `ticket.md` diffs) without writing.

### `syntaur status list [--json]`

Print the current statuses, order, and transitions, with a `source: config | default` marker (`--json` emits `{ statuses, order, transitions, source }`).

### `syntaur status init [--force] [--dry-run]`

Materialize the built-in defaults explicitly. Refuses to overwrite an existing custom block unless `--force`.

### `syntaur status reset [--force] [--dry-run]`

Remove the `statuses:` block and revert to implicit defaults.

### `syntaur status add <id> [--dry-run]`

```
syntaur status add <id> --label <label> [--color <hex>] [--icon <name>] \
  [--description <text>] [--terminal] [--after <id> | --before <id> | --at-end]
```

Append a new status. The position flags are mutually exclusive (default `--at-end`).

### `syntaur status set --id <id> [--dry-run]`

Edit metadata on an existing status without renaming it: `--label`, `--color`, `--icon`, `--description`, `--terminal true|false` (literal strings).

### `syntaur status reorder <ids> [--dry-run]`

Replace the order. `<ids>` is a comma-separated list that must be a permutation of the current ids (no drops or extras).

### `syntaur status remove <id> [--force] [--dry-run]`

Remove a status. Without `--force` it errors and lists any tickets still using the id. With `--force` it edits `config.md` only — it drops the status from `statuses`/`order` and prunes transitions referencing it; **affected `ticket.md` files are left untouched** (they now reference an undefined status, which `syntaur doctor` flags). It never deletes tickets.

### `syntaur status rename <id> --to <new-id> [--label <label>] [--dry-run]`

Rename a status id atomically across `config.md` AND every affected `ticket.md` (buffer-write-rollback: if any write fails, all originals are restored). Keeps the original label unless `--label` is given.

### `syntaur status transition add|remove [--dry-run]`

```
syntaur status transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]
syntaur status transition remove --from <id> --command <cmd>
```

Define or drop a custom transition.

## `syntaur project new` / `syntaur project list`

Create or list projects under `~/.syntaur/projects/`.

```
syntaur project new <title> [--slug <slug>] [--prefix <PFX>] [--dir <path>]
syntaur project list [--dir <path>]
```

`project new` scaffolds `project.md` (with `prefix`, `nextTicket`, and `defaultTemplate`), derived indexes, and an empty `tickets/` folder. When `--prefix` is omitted, a unique 2–5 letter prefix is derived from the slug. Prefixes must be unique across projects.

`project list` prints `slug`, `prefix`, and `title` (tab-separated).

### Examples

```bash
syntaur project new "Build Auth System"
syntaur project new "My App" --slug my-app --prefix MYA
syntaur project list
```

## `syntaur new`

Create a ticket and allocate the next `<PREFIX>-<n>` id from the target project's counter. Defaults to the **scratch** project (`projects/scratch/`, prefix `SCR`) when `--project` is omitted.

```
syntaur new <title> [--project <slug>] [--slug <slug>] [-t, --template <id>] \
  [--priority <level>] [--depends-on <ids>] [--links <ids>] [--dir <path>]
```

`-t, --template` selects the ticket template (defaults to the project's `defaultTemplate`, usually `feature`). Scaffolds template-declared files (`plan.md`, `journal.md`, etc.) per the manifest.

`--depends-on` and `--links` take comma-separated ticket ids (e.g. `SCR-1,BAS-2`). The ticket folder is created as `tickets/<ID>-<slug>/`.

### Examples

```bash
syntaur new "Fix login redirect"                    # → projects/scratch/tickets/SCR-n-<slug>/
syntaur new "Add OAuth" --project my-api
syntaur new "Wire refresh token" --project my-api --depends-on MYA-1
```

## `syntaur rename <id> <new-slug>`

Rename a ticket's display slug. Updates `slug` in `ticket.md` and renames the folder from `<ID>-<old-slug>` to `<ID>-<new-slug>`. The ticket id is unchanged.

```
syntaur rename <id> <new-slug> [--dir <path>]
```

### Examples

```bash
syntaur rename BAS-2 implement-jwt-auth
```

## `syntaur show [ticket]`

Render the agent guide for a ticket — objective, acceptance, workspace, dependencies, declared files with roles and state, log tail, stage instructions, **Next**, and **Commands**. Defaults to the session's open engagement when no ticket id is given.

```
syntaur show [ticket] [--project <slug>] [--json] [--log] [-t, --type <type>]
```

- `--json` — emit the structured show model.
- `--log` — print log entries only (falls back to chat notes when the template has no log role).
- `-t, --type` — filter log entries by entry type (with `--log`).

Chat standing context and adapter rules use this rendered text (not a hardcoded file list). Run at the start of work and after every lifecycle verb.

### Examples

```bash
syntaur show BAS-2
syntaur show BAS-2 --json
syntaur show BAS-2 --log -t progress
```

## `syntaur template`

Manage ticket template manifests under `~/.syntaur/templates/`.

```
syntaur template list [--json]
syntaur template new <id> --from <builtin>
syntaur template check [id] [--builtins] [--json]
syntaur template reset <builtin-id>
syntaur template reset --missing
```

Built-ins: `feature`, `bug`, `spike`, `quick`, `legacy`. `list` shows drift status for built-ins. `new` copies a built-in and strips the `builtin:` stamp. `check --builtins` reports `current` / `modified` / `outdated` / `missing`. `reset` restores shipped files for one built-in; `--missing` seeds only absent built-ins.

## `syntaur retemplate <ticket> <template>`

Switch a ticket to another template and scaffold any missing declared files. Updates `template:` in `ticket.md`, resets the `plan:` block when a new plan file is written, and records a `retemplated` audit event. Does not delete existing files.

```
syntaur retemplate <ticket> <template> [--project <slug>]
```

## `syntaur migrate v2`

One-time migration from v1 / Phase-A layout to v2 id-prefixed ticket folders. Dry-run by default; pass `--apply` to write. Creates a `.bak-v2-*` backup before applying.

```
syntaur migrate v2 [--apply] [--root <path>] [--prefix <slug=PFX> ...]
```

Two steps, recorded in the `v2-migrated` marker ledger:

1. **`rename-ids`** — Renames `assignments/` → `tickets/` and `_index-assignments.md` → `_index-tickets.md` where present; assigns each project a `prefix` and sequential ticket ids; renames folders to `<ID>-<slug>`; moves former standalone `~/.syntaur/tickets/<uuid>/` entries into `projects/scratch/`; re-keys SQLite tables (`events`, `engagement`, `chat_*`, `usage_*`).
2. **`templates`** — Seeds missing built-in templates; sets `template: legacy` on every ticket; renames `dependsOn` → `depends_on`; migrates `planApproval` → `plan:` block; drops `type`. Status mapping is deferred to `lifecycle-verbs`.

Dry-run / apply transcript lines (representative):

```
[dry-run] templates: seeded feature, bug, spike, quick, legacy
[dry-run] template legacy: 12 tickets
[dry-run] depends_on: 8 renamed
[dry-run] plan block: 5 tickets (3 approvals carried, 1 superseded approvals dropped)
[dry-run] dropped type: 12
[dry-run] status mapping deferred to lifecycle-verbs
```

`--prefix slug=PFX` overrides auto-derived prefixes (repeatable). `--root` sets the Syntaur home to migrate (default `~/.syntaur`). A bare-timestamp marker (pre-templates) re-runs only the `templates` step.

### Examples

```bash
# Preview changes
syntaur migrate v2

# Apply with a custom prefix for one project
syntaur migrate v2 --apply --prefix scratch=SCR --prefix my-api=API
```

## `syntaur workspace set`

Set the four `workspace.*` frontmatter fields on a ticket atomically. Validates the file (same checks as `syntaur doctor --ticket --json`) **before** writing and re-validates **after**, restoring the original on failure, and bumps `updated`.

```
syntaur workspace set \
  --repository <path> --worktree-path <path> --branch <name> --parent-branch <name> \
  [--ticket <id> [--project <slug>]]
```

Targets the active ticket from `.syntaur/context.json` unless `--ticket` is given (`<PREFIX>-<n>`). Provide at least one field flag.

## `syntaur progress log <text>`

Append a progress entry to the ticket's template log-role file. For modern templates this is usually `journal.md` (`## <timestamp> · progress · <author>` entries). The `legacy` template still uses `progress.md` with reverse-chronological `# Progress` entries — the CLI help text still says `progress.md` for that path. Templates with no log role error out (use chat instead).

```
syntaur progress log "<text>" [--ticket <id> [--project <slug>]]
```

## `syntaur unassign <ticket>`

Clear the assignee on a ticket (the inverse of `syntaur assign`) and bump `updated`.

```
syntaur unassign <id> [--project <slug>] [--dir <path>]
```

`<id>` is the ticket id (`<PREFIX>-<n>`).

## `syntaur worktree`

Manage git worktrees bound to tickets.

- `syntaur worktree create --branch <name> [--repository <path>] [--parent-branch <name>] [--ticket <id> [--project <slug>]] [--worktree-path <path>]` — create a worktree and record the workspace block.
- `syntaur worktree list [--repository <path>] [--json]` — list the repository's worktrees.
- `syntaur worktree remove` (alias `prune`) `[--ticket <id> [--project <slug>]] [--repository <path>] [--delete-branch] [--force]` — remove the ticket's worktree (git teardown first), optionally delete the branch, then clear the four `workspace.*` fields and bump `updated`. Without `--force`, git refuses a dirty/locked worktree.

## `syntaur plan`

Manage plan files for a ticket.

- `syntaur plan create [--ticket <id> [--project <slug>]] [--force]` — write the initial `plan.md` scaffold. Refuses to overwrite an existing `plan.md` without `--force`.
- `syntaur plan version [--ticket <id> [--project <slug>]] [--force]` — create the next `plan-v<N>.md` and carry forward unchecked tasks from the prior plan body.

## `syntaur timeline <ticket>`

Show the chronological audit event log for one ticket — who changed what, when, and what the value moved from→to — newest first.

```
syntaur timeline <ticket> [options]
```

`<ticket>` is a ticket id (`<PREFIX>-<n>`). `--project` is optional when the id is globally unique.

### Options

- `--project <slug>` — Project the ticket belongs to (optional when id resolves unambiguously).
- `--since <date>` — Only show events at or after this UTC ISO timestamp (inclusive: `at >= since`).
- `--type <list>` — Comma-separated event-type filter (e.g. `status-change,plan-approval`).
- `--limit <n>` — Maximum number of events to show (default: 50).
- `--json` — Emit a JSON array instead of a table.

### Tracked event types

| Event type | Triggered when |
|---|---|
| `status-change` | Ticket status moves from one value to another |
| `assignee-change` | Assignee is set, changed, or cleared |
| `priority-change` | Priority field changes |
| `archived` / `restored` | Ticket is archived or un-archived |
| `plan-approval` | A plan file is approved or rejected |
| `fact-set` | A structured fact is written via `syntaur fact set` |
| `attestation` | An attestation is recorded |
| `comment-added` | A comment is appended |
| `comment-resolved` | A comment is resolved |

### JSON output shape

```json
[
  {
    "id": "evt_01j…",
    "type": "status-change",
    "at": "2026-06-15T14:32:00.000Z",
    "actor": "claude",
    "from": "in-progress",
    "to": "review",
    "note": null
  }
]
```

The same events are surfaced live in the dashboard's **Activity** tab for the ticket.

### Examples

```bash
# Show the full event log for a ticket
syntaur timeline API-3 --project my-api

# Only status-change events since a specific date
syntaur timeline API-3 --project my-api \
  --type status-change --since 2026-06-01T00:00:00Z

# Emit JSON, capped at 10 events
syntaur timeline API-3 --project my-api --json --limit 10
```

## `syntaur migrate-events`

One-time backfill that synthesizes audit events from existing `statusHistory` and `planApproval` fields already present in `ticket.md` files. Dry-run by default; pass `--apply` to write.

```
syntaur migrate-events [options]
```

The command is **idempotent**: each synthesized event is stored with a deterministic `source_key` derived from the originating record, so re-running the command after `--apply` inserts 0 new events.

### Options

- `--dir <path>` — Override the default project directory (defaults to `~/.syntaur`).
- `--apply` — Write the backfilled events. Without this flag the command only prints what would be inserted.

### Examples

```bash
# Preview what would be backfilled (dry-run)
syntaur migrate-events

# Apply the backfill
syntaur migrate-events --apply

# Target a non-default project directory
syntaur migrate-events --apply --dir /path/to/my-projects
```

## `syntaur search <query>`

Full-text search across all Syntaur markdown content. Searches the bodies of every file kind tracked by a ticket and returns ranked results with a snippet and location.

```
syntaur search <query> [options]
```

### File kinds searched

| Kind | File |
|------|------|
| `ticket` | `ticket.md` |
| `plan` | Latest plan only — `plan-v<N>.md` supersedes `plan.md` when a versioned plan exists |
| `progress` | `progress.md` |
| `comments` | `comments.md` |
| `handoff` | `handoff.md` |
| `decision-record` | `decision-record.md` |
| `scratchpad` | `scratchpad.md` |

### Options

- `--project <slug>` — Restrict results to one project.
- `--type <list>` — Comma-separated ticket type filter.
- `--status <list>` — Comma-separated ticket status filter.
- `--in <fileKinds>` — Comma-separated file-kind filter. Accepts singular or plural names (e.g. `--in comment,plans` or `--in comments,plan`).
- `--all` — Include archived tickets and projects (excluded by default).
- `--limit <n>` — Maximum number of results. Default: `20`.
- `--semantic` — Use the semantic search provider when available; falls back to full-text automatically. The semantic layer is a designed-but-deferred seam — v1 uses full-text search via fuse.js.
- `--json` — Emit results as a JSON array instead of a table.

### JSON output shape

Each item in the `--json` array contains:

```json
{
  "path": "/abs/path/to/file.md",
  "project": "project-slug",
  "ticket": "ticket-slug",
  "fileKind": "plan",
  "score": 0.82,
  "snippet": "…matched text excerpt…",
  "line": 14,
  "section": "## Implementation",
  "route": "/tickets/my-ticket?tab=plan#implementation"
}
```

The `route` field is also used by the dashboard command palette: running a search from the palette deep-links directly to the matching ticket's `?tab=<kind>` pane at the `#section` anchor.

### Examples

```bash
# Find any mention of "rate limit" across all content
syntaur search "rate limit"

# Search only plans and handoffs in one project, return JSON
syntaur search "authentication flow" --project my-api --in plans,handoff --json

# Include archived tickets, cap at 5 results
syntaur search "stripe webhook" --all --limit 5
```

## `syntaur inbox`

One triage view of everything awaiting a human across all projects (including scratch). Read-only — prints the exact action command for each item; never mutates. Chat-sourced question rows print an **Open chat** URL; reply in the dashboard **Needs me** queue.

```
syntaur inbox [options]
```

### Options

- `--project <slug>` — Restrict to one project.
- `--type <list>` — Comma-separated category filter (valid categories: `question`, `review`, `plan-approval`).
- `--limit <n>` — Maximum number of items to show.
- `--max-age <days>` — Hide rows older than this many days (live permission/ask cards are always shown).
- `--show-snoozed` — Include snoozed rows in the output (human view adds a **Snoozed (N)** section).
- `--json` — Emit the structured `InboxResult` JSON instead of the grouped view.

Snoozes made in the dashboard are stored in `~/.syntaur/inbox-snoozes.json` and honoured by the CLI — snoozed rows are hidden unless `--show-snoozed` is set.

### Categories

| Category | What it means | Action command |
|---|---|---|
| `question` | Ticket has an open (unresolved) comment of type `question` (plain or chat-sourced) | Plain: `syntaur comment <id> "<answer>" --reply-to <commentId> --project <p>`. Chat: the `Open chat` URL in `action.command` |
| `review` | Ticket is in `review` status — awaiting accept or reopen | `syntaur complete <id> --project <p>` (accept) or `syntaur reopen <id> --project <p>` (reopen); exact command is derived from the lifecycle status-config |
| `plan-approval` | Ticket is in `ready_for_planning` status with a latest unapproved plan file | `syntaur plan approve <id> --project <p>` |

### What does NOT appear

- Archived tickets
- `draft`, `ready_to_implement`, `in_progress` tickets (agent is still working)
- `ready_for_planning` tickets without a latest unapproved plan (nothing to approve)
- Terminal statuses: `completed`, `failed`
- `parked` disposition tickets
- Resolved comments (`resolved: true`)
- `note` and `feedback` comment types (only `question` awaits a human answer)

### JSON output shape

`--json` emits an `InboxResult` object:

```json
{
  "items": [
    {
      "project": "my-api",
      "ticketSlug": "add-oauth",
      "ticketId": "API-3",
      "title": "Add OAuth support",
      "category": "review",
      "since": "2026-06-10T12:25:03Z",
      "ageMs": 575717277,
      "summary": "Review requested — awaiting accept or reopen.",
      "action": {
        "verb": "Accept",
        "command": "syntaur complete API-3 --project my-api"
      }
    }
  ],
  "counts": {
    "question": 0,
    "review": 3,
    "plan-approval": 2
  },
  "total": 6
}
```

### Examples

```bash
# Show everything awaiting your attention
syntaur inbox

# Emit structured JSON
syntaur inbox --json

# Filter to review and questions only
syntaur inbox --type review,question

# Restrict to one project
syntaur inbox --project my-api

# Cap output at 10 items
syntaur inbox --limit 10

# Hide rows older than 14 days (live cards exempt)
syntaur inbox --max-age 14

# List snoozed rows too
syntaur inbox --show-snoozed
```

The dashboard **Needs me** view is the GUI reply queue — live cards first, then chat replies, plain questions, plans, and reviews (oldest-first within each tier), with inline reply, allow/deny, approve, and accept/reopen controls, plus a nav badge that follows the page window (default last 14 days) and excludes snoozed rows. It live-updates via WebSocket whenever a ticket changes.

## Working a ticket

Agents are worked in the dashboard's **Chat** tab, not in a terminal Syntaur
opens for you. Open a ticket, send a message, and the dashboard server
speaks the Agent Client Protocol to a `claude-agent-acp` or `codex-acp` adapter
running in the ticket's worktree. See
[ticket-chat.md](./ticket-chat.md).

```
syntaur open <ticket>
```

`open` still opens a plain terminal (and your editor) at a ticket's
worktree. It reads an optional `terminal:` scalar from `~/.syntaur/config.md`
(`terminal-app` | `iterm` | `ghostty` | `alacritty` | `warp` | `kitty` |
`cmux`) and falls back to the platform default.

### Retired in v0.80

The terminal-launch stack is gone: the `syntaur://` URL scheme and
`install-url-handler`, `syntaur url`, `syntaur agents *`, `syntaur tui` (the
cockpit), `syntaur daemon` / `bg` / `attach` / `attach-doctor`, and
`syntaur session scan` / `scan-install` / `scan-uninstall`. See the
[v0.80 release note](./releases/v0.80.md) for the one-time cleanup an already-
installed machine needs.
