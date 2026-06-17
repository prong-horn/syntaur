# Syntaur CLI

Reference for `syntaur` subcommands. Run `syntaur --help` for a full list.

## `syntaur agents`

Manage configurable agents used by `syntaur browse` and future launch flows.

Agents live under the `agents:` list in `~/.syntaur/config.md`. When the block is absent, Syntaur uses built-in defaults (`claude`, `codex`, `pi`, `openclaw`, `hermes`). Every mutating subcommand accepts `--dry-run` to print the proposed change without writing.

### `syntaur agents list`

Print configured agents (or built-in defaults when none are configured). Each line shows `id`, `label`, `command`, and any flags (`default`, `shell-alias`, `prompt=<position>`).

### `syntaur agents add`

Add a new agent.

```
syntaur agents add --id <id> --label <label> --command <path> \
  [--args <csv>] \
  [--prompt-arg-position first|last|none] \
  [--default] \
  [--resolve-from-shell-aliases] \
  [--dry-run]
```

- `--id`, `--label`, `--command` are required.
- `--command` accepts an absolute path or a bare binary name. Relative paths with `/` are rejected.
- `--default` marks the agent as the default launch target (clears any prior default).
- `--resolve-from-shell-aliases` runs the command through `$SHELL -i -c '...'` so shell aliases resolve.
- `--dry-run` runs the same validation as a real write and prints the diff, but skips the config file write.

### `syntaur agents remove <id> [--dry-run]`

Remove a configured agent by id. Errors if the id does not exist.

### `syntaur agents set <id>`

Update one or more fields on an existing agent.

```
syntaur agents set <id> \
  [--label <label>] \
  [--command <path>] \
  [--args <csv>] \
  [--prompt-arg-position first|last|none] \
  [--default | --no-default] \
  [--resolve-from-shell-aliases | --no-resolve-from-shell-aliases] \
  [--dry-run]
```

Passing `--default` clears `default: true` on every other agent atomically. `--no-default` unsets the flag on this agent only.

### `syntaur agents reorder <ids>`

Reorder agents. `<ids>` is a comma-separated list that must cover every currently configured agent exactly once.

```
syntaur agents reorder codex,claude --dry-run
```

## `syntaur status`

Manage the assignment-status workflow — the `statuses:` block in `~/.syntaur/config.md` that the dashboard Settings page also edits. The runtime is **all-or-nothing**: once a `statuses:` block exists the built-in defaults are no longer merged. Every mutating verb accepts `--dry-run` to print a unified diff of the would-be `statuses:` block (and, for `rename`, per-file `assignment.md` diffs) without writing.

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

Remove a status. Without `--force` it errors and lists any assignments still using the id. With `--force` it edits `config.md` only — it drops the status from `statuses`/`order` and prunes transitions referencing it; **affected `assignment.md` files are left untouched** (they now reference an undefined status, which `syntaur doctor` flags). It never deletes assignments.

### `syntaur status rename <id> --to <new-id> [--label <label>] [--dry-run]`

Rename a status id atomically across `config.md` AND every affected `assignment.md` (buffer-write-rollback: if any write fails, all originals are restored). Keeps the original label unless `--label` is given.

### `syntaur status transition add|remove [--dry-run]`

```
syntaur status transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]
syntaur status transition remove --from <id> --command <cmd>
```

Define or drop a custom transition.

## `syntaur workspace set`

Set the four `workspace.*` frontmatter fields on an assignment atomically. Validates the file (same checks as `syntaur doctor --assignment --json`) **before** writing and re-validates **after**, restoring the original on failure, and bumps `updated`.

```
syntaur workspace set \
  --repository <path> --worktree-path <path> --branch <name> --parent-branch <name> \
  [--assignment <slug> [--project <slug>]]
```

Targets the active assignment from `.syntaur/context.json` unless `--assignment` is given. Provide at least one field flag.

## `syntaur progress log <text>`

Append a timestamped entry to the active assignment's `progress.md`: newest first (right after the `# Progress` H1), replacing the `No progress yet.` placeholder, incrementing `entryCount`, bumping `updated`, and preserving `assignment`/`generated`.

```
syntaur progress log "<text>" [--assignment <slug> [--project <slug>]]
```

## `syntaur session save`

Write the active session's continuity summary to `<assignmentDir>/sessions/<sessionId>/summary.md`. Preserves the existing `created` timestamp on re-save; the section body comes from `--from-file`, piped stdin, or a written skeleton. Never touches `handoff.md`.

```
syntaur session save [--session-id <id>] [--from-file <path>] [--assignment <slug> [--project <slug>]]
```

`--session-id` defaults to the `sessionId` in `.syntaur/context.json`; the command aborts if no real session id can be resolved.

## `syntaur unassign <assignment>`

Clear the assignee on an assignment (the inverse of `syntaur assign`) and bump `updated`.

```
syntaur unassign <assignment> [--project <slug>] [--dir <path>]
```

For standalone assignments pass the UUID and omit `--project`.

## `syntaur resource`

Manage project-level resources under `<projectDir>/resources/`. Every mutation regenerates `_index.md`.

- `syntaur resource add --project <slug> --name <name> --source <url-or-path> [--category <name>] [--slug <slug>] [--related-assignments <slugs>] [--force]`
- `syntaur resource list --project <slug> [--json]`
- `syntaur resource show <slug> --project <slug> [--json]`
- `syntaur resource update <slug> --project <slug> [--name] [--source] [--category] [--related-assignments]`
- `syntaur resource remove <slug> --project <slug> [--force]`

## `syntaur memory`

Manage project-level memories under `<projectDir>/memories/`. Every mutation regenerates `_index.md`.

- `syntaur memory add --project <slug> --name <name> --source <text> [--scope <scope>] [--source-assignment <slug>] [--slug <slug>] [--related-assignments <slugs>] [--force]`
- `syntaur memory list --project <slug> [--json]`
- `syntaur memory show <slug> --project <slug> [--json]`
- `syntaur memory update <slug> --project <slug> [--name] [--source] [--scope] [--source-assignment] [--related-assignments]`
- `syntaur memory remove <slug> --project <slug> [--force]`

## `syntaur worktree`

Manage git worktrees bound to assignments.

- `syntaur worktree create --branch <name> [--repository <path>] [--parent-branch <name>] [--assignment <slug> [--project <slug>]] [--worktree-path <path>]` — create a worktree and record the workspace block.
- `syntaur worktree list [--repository <path>] [--json]` — list the repository's worktrees.
- `syntaur worktree remove` (alias `prune`) `[--assignment <slug> [--project <slug>]] [--repository <path>] [--delete-branch] [--force]` — remove the assignment's worktree (git teardown first), optionally delete the branch, then clear the four `workspace.*` fields and bump `updated`. Without `--force`, git refuses a dirty/locked worktree.

## `syntaur plan`

Manage plan files for an assignment.

- `syntaur plan create [--assignment <slug> [--project <slug>]] [--force]` — write the initial `plan.md` and append the four-todo cycle to `assignment.md ## Todos`. Refuses to overwrite an existing `plan.md` without `--force`.
- `syntaur plan version [--assignment <slug> [--project <slug>]] [--force]` — create the next `plan-v<N>.md`, supersede the prior cycle, and carry forward unchecked tasks.

## `syntaur timeline <assignment>`

Show the chronological audit event log for one assignment — who changed what, when, and what the value moved from→to — newest first.

```
syntaur timeline <assignment> [options]
```

`<assignment>` is an assignment slug (paired with `--project`) or a standalone UUID.

### Options

- `--project <slug>` — Project the assignment belongs to (required for project-scoped assignments).
- `--since <date>` — Only show events at or after this UTC ISO timestamp (inclusive: `at >= since`).
- `--type <list>` — Comma-separated event-type filter (e.g. `status-change,plan-approval`).
- `--limit <n>` — Maximum number of events to show (default: 50).
- `--json` — Emit a JSON array instead of a table.

### Tracked event types

| Event type | Triggered when |
|---|---|
| `status-change` | Assignment status moves from one value to another |
| `assignee-change` | Assignee is set, changed, or cleared |
| `priority-change` | Priority field changes |
| `archived` / `restored` | Assignment is archived or un-archived |
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

The same events are surfaced live in the dashboard's **Activity** tab for the assignment.

### Examples

```bash
# Show the full event log for an assignment
syntaur timeline add-oauth --project my-api

# Only status-change events since a specific date
syntaur timeline add-oauth --project my-api \
  --type status-change --since 2026-06-01T00:00:00Z

# Emit JSON, capped at 10 events
syntaur timeline add-oauth --project my-api --json --limit 10
```

## `syntaur migrate-events`

One-time backfill that synthesizes audit events from existing `statusHistory` and `planApproval` fields already present in `assignment.md` files. Dry-run by default; pass `--apply` to write.

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

Full-text search across all Syntaur markdown content. Searches the bodies of every file kind tracked by an assignment and returns ranked results with a snippet and location.

```
syntaur search <query> [options]
```

### File kinds searched

| Kind | File |
|------|------|
| `assignment` | `assignment.md` |
| `plan` | Latest plan only — `plan-v<N>.md` supersedes `plan.md` when a versioned plan exists |
| `progress` | `progress.md` |
| `comments` | `comments.md` |
| `handoff` | `handoff.md` |
| `decision-record` | `decision-record.md` |
| `scratchpad` | `scratchpad.md` |
| `memory` | Project memory files under `<projectDir>/memories/` |
| `resource` | Project resource files under `<projectDir>/resources/` |

### Options

- `--project <slug>` — Restrict results to one project.
- `--type <list>` — Comma-separated assignment type filter.
- `--status <list>` — Comma-separated assignment status filter.
- `--in <fileKinds>` — Comma-separated file-kind filter. Accepts singular or plural names (e.g. `--in comment,plans` or `--in comments,plan`).
- `--all` — Include archived assignments and projects (excluded by default).
- `--limit <n>` — Maximum number of results. Default: `20`.
- `--semantic` — Use the semantic search provider when available; falls back to full-text automatically. The semantic layer is a designed-but-deferred seam — v1 uses full-text search via fuse.js.
- `--json` — Emit results as a JSON array instead of a table.

### JSON output shape

Each item in the `--json` array contains:

```json
{
  "path": "/abs/path/to/file.md",
  "project": "project-slug",
  "assignment": "assignment-slug",
  "fileKind": "plan",
  "score": 0.82,
  "snippet": "…matched text excerpt…",
  "line": 14,
  "section": "## Implementation",
  "route": "/assignments/my-assignment?tab=plan#implementation"
}
```

The `route` field is also used by the dashboard command palette: running a search from the palette deep-links directly to the matching assignment's `?tab=<kind>` pane at the `#section` anchor.

### Examples

```bash
# Find any mention of "rate limit" across all content
syntaur search "rate limit"

# Search only plans and handoffs in one project, return JSON
syntaur search "authentication flow" --project my-api --in plans,handoff --json

# Include archived assignments, cap at 5 results
syntaur search "stripe webhook" --all --limit 5
```

## `syntaur inbox`

One triage view of everything awaiting a human across all projects and standalone assignments. Read-only — prints the exact action command for each item; never mutates.

```
syntaur inbox [options]
```

### Options

- `--project <slug>` — Restrict to one project.
- `--type <list>` — Comma-separated category filter (valid categories: `review`, `blocked`, `question`, `plan-approval`).
- `--limit <n>` — Maximum number of items to show.
- `--json` — Emit the structured `InboxResult` JSON instead of the grouped view.

### Categories

| Category | What it means | Action command |
|---|---|---|
| `review` | Assignment is in `review` status — awaiting accept or reopen | `syntaur complete <slug> --project <p>` (accept) or `syntaur reopen <slug> --project <p>` (reopen); exact command is derived from the lifecycle status-config |
| `blocked` | Assignment is in `blocked` status — something is preventing progress | `syntaur unblock <slug> --project <p>` |
| `question` | Assignment has an open (unresolved) comment of type `question` | `syntaur comment <slug> "<answer>" --reply-to <commentId> --project <p>` — posts a reply; marking the comment resolved is dashboard-only |
| `plan-approval` | Assignment is in `ready_for_planning` status with a latest unapproved plan file | `syntaur plan approve <slug> --project <p>` |

For standalone assignments (no project), omit `--project` and use the assignment UUID as the target.

### What does NOT appear

- Archived assignments
- `draft`, `ready_to_implement`, `in_progress` assignments (agent is still working)
- `ready_for_planning` assignments without a latest unapproved plan (nothing to approve)
- Terminal statuses: `completed`, `failed`
- `parked` disposition assignments
- Resolved comments (`resolved: true`)
- `note` and `feedback` comment types (only `question` awaits a human answer)

### JSON output shape

`--json` emits an `InboxResult` object:

```json
{
  "items": [
    {
      "project": "my-api",
      "assignmentSlug": "add-oauth",
      "assignmentId": "dc8c06c1-531a-457f-a8f8-79692294e83e",
      "title": "Add OAuth support",
      "category": "review",
      "since": "2026-06-10T12:25:03Z",
      "ageMs": 575717277,
      "summary": "Review requested — awaiting accept or reopen.",
      "action": {
        "verb": "Accept",
        "command": "syntaur complete add-oauth --project my-api"
      }
    }
  ],
  "counts": {
    "review": 3,
    "blocked": 1,
    "question": 0,
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

# Filter to review and blocked only
syntaur inbox --type review,blocked

# Restrict to one project
syntaur inbox --project my-api

# Cap output at 10 items
syntaur inbox --limit 10
```

The dashboard **Needs me** view is the GUI equivalent — it shows the same grouped list with inline action controls and live-updates via WebSocket whenever an assignment changes.

## Launch flow

`syntaur browse` opens the TUI browser and, when you pick an assignment, launches an agent.

```
syntaur browse [--agent <id>] [--no-worktree-prompt]
```

### Agent selection

Resolution order:

1. Zero agents configured → error pointing at `syntaur agents add`.
2. One agent configured (or built-in defaults with one agent) → launch directly.
3. Multiple agents configured → interactive picker (pre-selects `default: true`).

`--agent <id>` bypasses the picker. Unknown ids exit with a clear error.

### Worktree / branch prompt

If the selected assignment is missing `workspace.worktreePath` or `workspace.branch`, the launcher runs the following matrix (first match wins):

| Condition | Behavior |
|-----------|----------|
| `--no-worktree-prompt` set | Fall back to existing cwd logic. No prompt, no create. |
| `worktreePath` AND `branch` already set | Use them as cwd. No prompt. |
| `agentDefaults.autoCreateWorktree: skip` | Fall back to cwd logic. No prompt, no create. |
| `agentDefaults.autoCreateWorktree: always` | Create a worktree with inferred defaults (no prompt). |
| default / `ask` | Interactively prompt (`y/n`). On accept, prompt for repository, branch, parent branch, and worktree path. |

Inferred defaults:

- **repository**: `workspace.repository` if set, else the current `git rev-parse --show-toplevel`.
- **branch**: `syntaur/<project-slug>/<assignment-slug>`, or `syntaur/<assignment-slug>` for standalone assignments.
- **parent branch**: current branch, falling back to `main`.
- **worktree path**: `~/.syntaur/worktrees/<project-slug>/<assignment-slug>` (expanded to an absolute path).

On accept, Syntaur runs `git worktree add -b <branch> <worktreePath> <parentBranch>`, writes the four fields back into `assignment.md` (atomic update), and launches the agent with the new worktree as `cwd`. If the frontmatter write fails after the worktree was created, Syntaur rolls back the worktree and branch so `assignment.md` and git state stay consistent.

When the user declines (or `--no-worktree-prompt` is set, or `autoCreateWorktree: skip`), the launcher falls back to `detail.workspace.worktreePath` → `detail.workspace.repository` → `process.cwd()` and prints a one-line warning naming the chosen cwd.

### Shell aliases

If the configured `command` is a shell alias (e.g. `c='claude --dangerously-skip-permissions'`), set `resolveFromShellAliases: true` on that agent. Syntaur will execute `$SHELL -i -c '<quoted command + args>'` so the alias resolves. When `$SHELL` is unset or not absolute, Syntaur falls back to `/bin/sh` and prints a warning.

When launch fails:

- `ENOENT` → "command not found — if this is a shell alias, enable `resolveFromShellAliases: true`."
- `EACCES` → "command is not executable — check file permissions."
- Anything else → the underlying errno and message.
