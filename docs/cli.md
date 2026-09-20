# Syntaur CLI

Reference for `syntaur` subcommands. Run `syntaur --help` for a full list.

## Lifecycle verbs

Status moves only by explicit verbs. Each verb evaluates template gates at call time; `--force` skips gates and records `forced: true` on the `moved` event.

### Stage verbs

```
syntaur plan create [--ticket <id> [--project <slug>]] [--by <name>] [--force]
syntaur plan version [--ticket <id> [--project <slug>]] [--by <name>] [--force]
syntaur approve <id> [--project <slug>] [--by <name>] [--force]
syntaur start <id> [--project <slug>] [--agent <id>] [--by <name>] [--force]
syntaur review <id> [--project <slug>] [--by <name>] [--force]
syntaur done <id> [--project <slug>] [--by <name>] [--force]
syntaur drop <id> "<reason>" [--project <slug>] [--by <name>]
syntaur reopen <id> [--project <slug>] [--by <name>]
```

- `plan create` / `plan version` — scaffold or version the plan file; `plan version` also moves to `planning` when the template declares that stage. Use `--by` for audit attribution on the stage move.
- `approve` — approve the plan and move to `ready` when the template declares it.
- `start` — move to `in_progress`; runs `plan-approved`, `deps-done`, and `workspace-set` gates per template. On `start` only, `--agent <id>` names the **stage dispatch recipient** (one automatic handoff turn when the template allows it), not the audit actor. Use `--by <name>` on any lifecycle verb to attribute the move in the event log (`human` by default).
- `review` — move to `review`.
- `done` — move to `done`; runs template `gates.done`.
- `drop` — move to `dropped`; reason required.
- `reopen` — move from `done` or `dropped` back to the stage before `done` in the template subset.

### Flag verbs

```
syntaur block <id> "<reason>" [--project <slug>] [--by <name>]
syntaur unblock <id> [--project <slug>] [--by <name>]
syntaur park <id> "<reason>" [--project <slug>] [--by <name>]
syntaur unpark <id> [--project <slug>] [--by <name>]
```

`block` and `park` set frontmatter flags (`blocked`, `parked`) without changing stage. Reason is required. `--by` attributes the flag change in the audit log.

### Plan file verbs

```
syntaur plan create [--ticket <id> [--project <slug>]] [--force]
syntaur plan version [--ticket <id> [--project <slug>]] [--force]
```

`plan version` creates the next `plan-v<N>.md`, sets `plan.file`, clears approval, and moves to `planning` when the template declares that stage.

Gate failure: `Cannot <verb> <ID>: <gate> — <reason>. Next: <hint>` (exit 1).

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

Chat standing context and adapter rules use this rendered text (not a hardcoded file list). Run at the start of work and after every lifecycle verb. The text includes **Handoff:** (latest log handoff entry) and **Agent:** (stage dispatch status) on separate lines.

### Examples

```bash
syntaur show BAS-2
syntaur show BAS-2 --json
syntaur show BAS-2 --log -t progress
```

Commands line (representative): `syntaur log BAS-2 -t progress "..."`; `syntaur block BAS-2 "<reason>"`; ask via `syntaur log -t question` or @mention in chat.

## `syntaur log <ticket> <body>`

Append a typed entry to the ticket's log-role file (`journal.md` on modern templates, `progress.md` on `legacy`). When the template has no log role, appends a chat note under `chat/` instead.

```
syntaur log <ticket> <body> -t, --type <type> [--project <slug>] [--agent <id>]
  [--verdict approve|changes] [--open high=<n>,medium=<n>]   # required for review
  [--answers <question-entry-iso>]                            # required for answer
  [--attach <path>]                                           # repeatable; images only
```

### Entry types (seven)

| Type | Purpose | Extra flags |
|------|---------|-------------|
| `progress` | Work log after meaningful steps | — |
| `decision` | Architecturally significant choice (Status / Context / Decision / Consequences in body) | — |
| `handoff` | Baton-pass summary for reviewers or the next session (`handoff-logged` gate) | — |
| `note` | General record not fitting other types | — |
| `question` | Ask the human something; rolls into Needs me until answered | — |
| `answer` | Reply to an open question | `--answers <ISO timestamp of question entry>` |
| `review` | Review verdict for `review-clean` gate | `--verdict`, `--open high=<n>,medium=<n>` |

`--agent` defaults to the session agent id when tracked, otherwise `human`. Image paths on `--attach` are copied into `chat/attachments/` and referenced on the entry.

### Examples

```bash
syntaur log API-3 -t progress "Finished OAuth callback handler" --project my-api
syntaur log API-3 -t question "Should refresh tokens be revocable?" --project my-api
syntaur log API-3 -t answer "Yes — store hashes in DB" --answers 2026-06-15T10:00:00Z --project my-api
syntaur log API-3 -t review "LGTM" --verdict approve --open high=0,medium=0 --project my-api
syntaur log API-3 -t handoff "Ready for merge; tests green" --project my-api
syntaur show API-3 --log -t progress
```

## `syntaur progress log <text>`

Alias of `syntaur log -t progress` for the active ticket (or `--ticket <id> [--project <slug>]`). Resolves the open engagement when no ticket is given.

```
syntaur progress log "<text>" [--ticket <id> [--project <slug>]]
```

On modern templates this writes a `progress` entry to `journal.md`. The `legacy` template still targets `progress.md` (newest-first `# Progress` layout).

## `syntaur migrate journal`

Merge legacy per-purpose record files into `journal.md` and switch the ticket off the `legacy` template. Dry-run by default; pass `--apply` to write. Creates `.migrate-journal.bak/` before applying.

```
syntaur migrate journal [<id>] [--project <slug>] [--all] [--template <id>] [--apply]
```

**Sources merged (when present and non-empty):** `progress.md`, `decision-record.md`, `handoff.md`, `comments.md`, `scratchpad.md` — converted to typed log entries, sorted oldest-first, written to `journal.md`. Legacy files are copied into `.migrate-journal.bak/` on apply and deleted after a successful merge; the backup dir is removed on success.

**Refuse / resume:** Refuses when `journal.md` exists with neither legacy sources nor a complete backup (already migrated). Refuses when the ticket template is not `legacy` and no `journal.md` exists. Resumes when `journal.md` coexists with legacy sources or a complete backup (for example after a crash between template switch and source deletion). `--all` skips tickets that are not `legacy` and have no sources or backup to resume. Both modes print `projects: <absolute path>` first, resolving the projects tree from `config.md` `defaultProjectDir` (same as `syntaur show`, `inbox`, and `search`).

Default `--template` is `feature`. Per-ticket mode takes a ticket id; `--project <slug> --all` migrates every `legacy` ticket in that project.

### Examples

```bash
# Preview one ticket
syntaur migrate journal LEG-12 --project my-api

# Apply all legacy tickets in scratch
syntaur migrate journal --project scratch --all --apply
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

Four steps, recorded in the `v2-migrated` marker ledger:

1. **`rename-ids`** — Renames `assignments/` → `tickets/` where present; assigns each project a `prefix` and sequential ticket ids; renames folders to `<ID>-<slug>`; moves former standalone `~/.syntaur/tickets/<uuid>/` entries into `projects/scratch/`; re-keys SQLite tables (`events`, `engagement`, `chat_*`, `usage_*`).
2. **`templates`** — Seeds missing built-in templates; sets `template: legacy` on every ticket; renames the legacy dependency frontmatter key to `depends_on`; migrates the legacy plan-approval block to `plan:`; drops `type`.
3. **`statuses`** — Maps v1 statuses to v2 stages (`draft→backlog`, legacy planning→`planning`, legacy ready→`ready`, `completed→done`, `failed→dropped`, etc.); folds the legacy blocked-reason scalar into the `blocked` flag; adds `parked: null`; re-renders each ticket to the 17-field v2 frontmatter shape; backfills missing audit rows from legacy frontmatter history then rewrites `status-change` / `plan-approval` events to `moved` / `plan-approved`.
4. **`derived`** — Deletes derived project markdown (`manifest.md`, `_index-*.md`, `_status.md`, `resources/_index.md`, `memories/_index.md`); strips `entryCount`, `handoffCount`, `decisionCount`, and `updated` from legacy record files; injects `**Recorded:**` lines on undated decision and handoff blocks using the file’s former `updated` timestamp before the strip.

Dry-run / apply transcript lines (representative):

```
[dry-run] templates: seeded feature, bug, spike, quick, legacy
[dry-run] template legacy: 12 tickets
[dry-run] depends_on: 8 renamed
[dry-run] plan block: 5 tickets (3 approvals carried, 1 superseded approvals dropped)
[dry-run] dropped type: 12
[dry-run] statuses: 12 tickets mapped (backlog 3, planning 2, ready 1, in_progress 0, review 0, done 4, dropped 2)
[dry-run] archived → dropped: 0
[dry-run] flags: blocked 1, parked 0
[dry-run] history: 5 backfilled, 3 status-change and 2 plan-approval rows rewritten
[dry-run] mapped: draft→backlog 3, …→planning 2, completed→done 4
[dry-run] worktree: 0 renamed
[dry-run] dropped fields: 48
[dry-run] removed: derive-migrated, stages-migrated, workflows/
[dry-run] derived: 85 files removed (manifest.md 15, _index-tickets.md 15, _index-plans.md 15, _index-decisions.md 15, _status.md 15, resources/_index.md 5, memories/_index.md 5)
[dry-run] counters: 1284 record files stripped (entryCount 643, handoffCount 321, decisionCount 321, updated 1284); recorded lines injected: decisions 748, handoffs 12
```

`--prefix slug=PFX` overrides auto-derived prefixes (repeatable). `--root` sets the Syntaur home to migrate (default `~/.syntaur`). A bare-timestamp marker (pre-templates) re-runs only the `templates` step. A home whose ledger already has the first three steps runs only `derived`.

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

- `syntaur plan create [--ticket <id> [--project <slug>]] [--by <name>] [--force]` — write the initial `plan.md` scaffold. Refuses to overwrite an existing `plan.md` without `--force`. Moves to `planning` when the template declares that stage.
- `syntaur plan version [--ticket <id> [--project <slug>]] [--by <name>] [--force]` — create the next `plan-v<N>.md` and carry forward unchecked tasks from the prior plan body.

## `syntaur hooks`

Install or remove Syntaur session hooks in Claude Code's `~/.claude/settings.json`.

- `syntaur hooks install` — copy scripts to `~/.syntaur/hooks/` (mode `0755`) and register three hook events: `SessionStart` → `session-start.sh`, `PostToolUse` → `session-touch.sh`, `UserPromptSubmit` → `prompt-context.sh`. Backs up the previous `hooks` object to `~/.syntaur/hooks.backup.json` before the first mutation. Idempotent on re-run. Foreign hooks (for example your own `PreToolUse` entry) are preserved.
- `syntaur hooks uninstall` — remove Syntaur hook entries whose commands point at `~/.syntaur/hooks/`, delete that directory, leave the backup file.

## `syntaur statusline`

Install, configure, or remove the syntaur `statusLine` entry in Claude Code settings.

- `syntaur statusline install [--mode replace|wrap|skip|ask] [--link]` — install `~/.syntaur/statusline.sh` and wire settings (wraps an existing status line by default in non-TTY).
- `syntaur statusline configure [--preset <name>] [--segments <list>] [--separator <string>] [--wrap <path>] [--preview]` — segment order and composition.
- `syntaur statusline uninstall [--keep-script]` — remove the settings entry; restores from `~/.syntaur/statusline.backup.json` when present.

## `syntaur history <ticket>`

Show the git commit history for a ticket folder under the Syntaur home (the home must be a git repository from `syntaur init`). Commits are listed newest first with the UTC timestamp, short SHA, subject, and count of paths under that ticket directory touched in each commit.

```
syntaur history <ticket> [options]
```

`<ticket>` is a ticket id (`<PREFIX>-<n>`) or slug with `--project`.

### Options

- `--project <slug>` — Project the ticket belongs to (required when `<ticket>` is a slug).
- `--limit <n>` — Maximum number of commits to show (default: 50).
- `--json` — Emit a JSON array of `{ sha, at, subject, files }` objects.
- `--events` — Show the SQLite events table for the ticket instead of git history (same output as `syntaur timeline`).

Git history follows the ticket folder path only; renames start a new history (no `--follow` across folder renames).

## `syntaur timeline <ticket>`

Show the chronological audit event log for one ticket — who changed what, when, and what the value moved from→to — newest first.

```
syntaur timeline <ticket> [options]
```

`<ticket>` is a ticket id (`<PREFIX>-<n>`). `--project` is optional when the id is globally unique.

### Options

- `--project <slug>` — Project the ticket belongs to (optional when id resolves unambiguously).
- `--since <date>` — Only show events at or after this UTC ISO timestamp (inclusive: `at >= since`).
- `--type <list>` — Comma-separated event-type filter (e.g. `moved,plan-approved`).
- `--limit <n>` — Maximum number of events to show (default: 50).
- `--json` — Emit a JSON array instead of a table.

### Tracked event types

| Event type | Payload | Triggered when |
|---|---|---|
| `created` | — | Ticket is created |
| `moved` | `from`, `to`, `verb`, `by`, `forced` | Stage changes via a lifecycle verb |
| `flagged` | `flag`, `reason` | `block` or `park` sets a flag |
| `unflagged` | `flag` | `unblock` or `unpark` clears a flag |
| `plan-approved` | `file`, `digest` | Plan is approved via `approve` |
| `plan-versioned` | `file` | New plan version created |
| `logged` | `type` | Log-role entry appended via `syntaur log` |
| `dispatched` | `agent`, `stage`, `requestId`, `entryId`, `source` | Stage handoff accepted by the chat broker (one turn queued) |
| `retemplated` | `from`, `to` | Template switched via `retemplate` |

### JSON output shape

```json
[
  {
    "id": "evt_01j…",
    "type": "moved",
    "at": "2026-06-15T14:32:00.000Z",
    "actor": "claude",
    "from": "in_progress",
    "to": "review",
    "verb": "review",
    "forced": false
  }
]
```

The same events are surfaced live in the dashboard's **Activity** tab for the ticket.

### Examples

```bash
# Show the full event log for a ticket
syntaur timeline API-3 --project my-api

# Only moved events since a specific date
syntaur timeline API-3 --project my-api \
  --type moved --since 2026-06-01T00:00:00Z

# Emit JSON, capped at 10 events
syntaur timeline API-3 --project my-api --json --limit 10
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
| `journal` | `journal.md` (log role on modern templates) |
| `progress` | `progress.md` (`legacy` log role) |
| `scratchpad` | `scratchpad.md` |

### Options

- `--project <slug>` — Restrict results to one project.
- `--template <list>` — Comma-separated ticket template filter.
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

The `route` field is also used by the dashboard's visible Search dialog: selecting a result opens the matching ticket's `?tab=<kind>` pane at the `#section` anchor.

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
| `question` | Ticket has an open `question` log entry with no matching `answer` (plain or chat-sourced) | Plain: `syntaur log <id> -t answer "..." --answers <question-ts> --project <p>`. Chat: the `Open chat` URL in `action.command` |
| `review` | Ticket is in `review` stage — awaiting `done` or `reopen` | `syntaur done <id> --project <p>` or `syntaur reopen <id> --project <p>` |
| `plan-approval` | Ticket has an unapproved plan-role file (any non-terminal stage) | `syntaur approve <id> --project <p>` |

### What does NOT appear

- Archived tickets
- `in_progress` tickets (agent is still working)
- Tickets without an unapproved plan-role file (nothing to approve)
- Terminal stages: `done`, `dropped`
- Tickets with `parked` flag set
- Answered questions (an `answer` entry names the question timestamp)
- `note` log types (only `question` awaits a human answer)

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
        "verb": "Done",
        "command": "syntaur done API-3 --project my-api"
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

## Hooks

`syntaur hooks install` writes three entries into `~/.claude/settings.json`. Each runs a bash script under `~/.syntaur/hooks/` with the hook JSON payload on stdin. Hook paths exit 0 even on failure.

| Script | Hook event | Purpose |
|--------|------------|---------|
| `session-start.sh` → `syntaur session register --from-hook` | `SessionStart` | Register the session row; merge session fields into `.syntaur/context.json` when present |
| `session-touch.sh` → `syntaur session touch --from-hook` | `PostToolUse` | Rate-limited heartbeat (`updated_at`) on tool use |
| `prompt-context.sh` → `syntaur session context --from-hook` | `UserPromptSubmit` | Inject stage block JSON **and** bump `updated_at` (touch runs inside `session context`) |

There is **no SessionEnd hook**. Closing a terminal does not mark the session stopped. To close a session by hand, pipe its id to the stop verb: `printf '{"session_id":"<id>"}' | syntaur session stop --from-hook`. Otherwise the dashboard's maintenance loop closes rows idle past `session.idleSweepHours` (default 6 h) on its first tick after start and every 45 s, and a ticket reaching `done` closes the sessions engaged on it.

Text mode (`syntaur session context --session-id <id>`) prints the same block for measurement and debugging.

An explicit `syntaur track-session --ticket <id>` re-binds the session's open engagement to that ticket (closing any open engagement on another ticket) so the prompt hook names the ticket you just tracked.

Block shape:

```
# Syntaur
Ticket: <ID> · <title> · <template> · stage: <stage id>
Stage instructions: <verbatim multi-line text when declared>
Next: <hint from syntaur show>
Run `syntaur show <ID>` for files, gates and commands.

## Playbooks
### <name>
<body>
```

When the session has no open engagement, only the `## Playbooks` section prints (if any cross-template playbooks are enabled). When a stage is not declared by the ticket's template, the block includes `Stage: <id> (not declared by template <t>)` and omits the instructions line. A `dropped` ticket shows `stage: dropped` with no instructions line.

**Cross-template playbooks** are enabled playbooks whose slug is not listed in the `playbooks` field of any template manifest (home copies first, shipped built-ins for ids the home lacks). Disabled slugs in `config.md` and slugs claimed by any template are excluded. The derived manifest under `~/.syntaur/playbooks/` is for the dashboard Library only — the hook reads playbook files directly, not that index.

## Stage dispatch and offline behavior

Stage-owned handoff requires the dashboard server for this Syntaur home (`syntaur dashboard`). The CLI reads `~/.syntaur/dashboard-port` and POSTs dispatch to `127.0.0.1` — no automatic server start and no default-port fallback.

When a lifecycle verb succeeds but dispatch cannot be accepted (dashboard stopped, wrong home, timeout before acceptance), the CLI still exits 0 for the stage move and prints dispatch status separately. Retry from the ticket page **Hand to** control; do not repeat the lifecycle verb. After network uncertainty, retry the **same** request id until the receipt is terminal; mint a new id only for an intentional new handoff after failure or completion.

Automatic request ids are `auto~<stageEntryId>` (one automatic dispatch per stage entry). Manual handoffs use a fresh UUID per intentional attempt.

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

Also removed: `syntaur status *` (custom status workflow in `config.md`),
`syntaur complete` / `syntaur fail`, `syntaur fact set`, `syntaur attest`,
`syntaur migrate-events` (superseded by `migrate v2` step `statuses`), and the
`manage-statuses` skill. Lifecycle moves use the verbs in
[Lifecycle verbs](#lifecycle-verbs) above (`plan`, `approve`, `start`,
`review`, `done`, `drop`, `reopen`, `block`, `unblock`, `park`, `unpark`).

Plugin and adapter install commands removed in this release: `setup`,
`install-plugin`, `install-codex-plugin`, `setup-adapter`, `uninstall`,
`uninstall-skills`. Statusline commands renamed: `install-statusline` →
`syntaur statusline install`, `configure-statusline` → `statusline configure`,
`uninstall-statusline` → `statusline uninstall`. Retired skills (use the six-pack
names instead): `clear-ticket`, `create-ticket`, `doctor-syntaur`, `list-tickets`,
`project-new`, `replan`, `resume-session`, `run-playbook`, `set-workspace`,
`track-session`, and the renamed predecessors `grab-ticket`, `plan-ticket`,
`complete-ticket`, `log-progress`, `syntaur-worktree`.
