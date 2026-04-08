# Quick Todos — Design Document

**Date:** 2026-04-07
**Status:** Draft — pending review

---

## 1. Overview

Quick Todos are a lightweight, workspace-scoped checklist for tasks too small to warrant a full mission or assignment. They live outside the mission/assignment hierarchy as a top-level concept within a workspace.

Key properties:
- No lifecycle machinery (no pending → active → review → completed states)
- Flat checklist with short IDs, tags, and simple status markers
- Agents can be dispatched to work on items conversationally or via CLI
- Completion log provides traceability without assignment-level ceremony
- Items can be promoted to full assignments when they turn out to be bigger than expected

---

## 2. File Layout

```
~/.syntaur/todos/
  _global.md                       # Global checklist (no workspace)
  _global-log.md                   # Global log
  <workspace-slug>.md              # Active checklist per workspace
  <workspace-slug>-log.md          # Append-only completion/activity log
  archive/
    <workspace-slug>-<period>.md   # Rotated log archives (e.g., syntaur-2026-W14.md)
    _global-<period>.md            # Rotated global log archives
```

Files are created on first `syntaur todo add`. The `_global` files follow the same format as workspace files but omit the `workspace` frontmatter field (or set it to `_global`).

---

## 3. Checklist File Format

**Ownership:** Human-authored, agent-writable (agents update status markers and session claims)

### Frontmatter

```yaml
---
workspace: syntaur
archiveInterval: weekly   # daily | weekly | monthly | never
---
```

| Field             | Type   | Required | Default  | Description                                      |
|-------------------|--------|----------|----------|--------------------------------------------------|
| `workspace`       | string | required | —        | Workspace slug this checklist belongs to          |
| `archiveInterval` | string | optional | `weekly` | How often completed items and logs are archived   |

### Body

Each item is a markdown list entry with a status marker, description, optional tags, and a short ID:

```markdown
# Quick Todos

- [ ] Fix broken link in README #docs [t:a3f1]
- [>:d4e8f1a9] Add timeout to health check endpoint #api [t:b7c2]
- [x] Rename getUserById to findUser #api #refactor [t:d4e8]
- [!] Update error messages in auth flow #cleanup [t:f9a0]
```

### Status Markers

| Marker          | Meaning     | Description                                         |
|-----------------|-------------|-----------------------------------------------------|
| `[ ]`           | Open        | Not started                                         |
| `[>:SESSION_ID]`| In Progress | Agent is actively working; session ID prevents conflicts |
| `[x]`           | Completed   | Done, log entry exists                              |
| `[!]`           | Blocked     | Cannot proceed, reason in log                       |

### Item Syntax

```
- [STATUS] DESCRIPTION #tag1 #tag2 [t:SHORT_ID]
```

- **Short ID:** 4-character hex, generated on creation. Prefixed with `t:` for namespacing. Used in CLI commands, log cross-references, and API calls.
- **Tags:** Inline `#tag` tokens. Freeform, no predefined vocabulary. Used for filtering in CLI and dashboard.
- **Description:** Free text between the status marker and the first `#tag` or `[t:...]`.

---

## 4. Log File Format

**Ownership:** Agent-writable, append-only

**File:** `<workspace-slug>-log.md`

### Structure

```markdown
---
workspace: syntaur
---

# Todo Log

### 2026-04-07T14:30:00Z — t:a3f1, t:b7c2
**Items:** Fix broken link in README, Add timeout to health check endpoint
**Session:** d4e8f1a9
**Branch:** fix/readme-and-timeout
**Summary:** Fixed dead link pointing to old docs domain. Added 30s timeout to /healthz.

### 2026-04-07T16:00:00Z — t:d4e8
**Items:** Rename getUserById to findUser across the API
**Session:** a3b7c2f0
**Branch:** refactor/find-user-rename
**Summary:** 14 files changed. Updated all call sites and tests.
**Blockers:** The GraphQL resolver still references the old name — needs a schema migration.

### 2026-04-07T16:05:00Z — t:f9a0
**Items:** Update error messages in auth flow
**Status:** blocked
**Reason:** Depends on auth middleware rewrite tracked in mission build-auth-system.
```

### Log Entry Fields

| Field       | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| Heading     | required | Timestamp + item ID(s). Heading level `###`.             |
| **Items**   | required | Human-readable descriptions of the items worked on       |
| **Session** | optional | Agent session ID (present when agent did the work)       |
| **Branch**  | optional | Git branch where changes were made                       |
| **Summary** | required | Brief description of what was done or why status changed |
| **Blockers**| optional | What's preventing completion                             |
| **Status**  | optional | Only present for non-completion entries (e.g., `blocked`)|

---

## 5. Archiving

### Trigger

- **Cron:** Runs on the configured `archiveInterval` (daily/weekly/monthly)
- **Manual:** `syntaur todo archive [--workspace <slug>]`

### Behavior

1. Read the checklist file. Collect all `[x]` completed items.
2. Read the log file. Collect all log entries whose item IDs are all `[x]` in the checklist.
3. Append collected log entries to the archive file for the current period.
4. Remove collected `[x]` items from the checklist file.
5. Remove archived entries from the log file.

### Archive File Naming

| Interval | File name pattern                      | Example                    |
|----------|----------------------------------------|----------------------------|
| daily    | `<workspace>-<YYYY-MM-DD>.md`         | `syntaur-2026-04-07.md`    |
| weekly   | `<workspace>-<YYYY>-W<WW>.md`         | `syntaur-2026-W14.md`      |
| monthly  | `<workspace>-<YYYY>-<MM>.md`          | `syntaur-2026-04.md`       |

Archive files are append-only. They contain the archived checklist items (for reference) followed by their log entries.

---

## 6. Promote to Assignment

A todo item can be promoted to a full assignment when it turns out to be more complex than expected.

**CLI:** `syntaur todo promote t:f9a0 --mission build-auth-system`

**Behavior:**

1. Prompt for target mission (or `--mission` flag). If no mission specified, list available missions in the workspace.
2. Generate an assignment slug from the todo description.
3. Scaffold assignment files (`assignment.md`, `plan.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`).
4. Pre-populate `assignment.md` description with the todo text.
5. If log entries exist for this item, include them as context in the assignment description or scratchpad.
6. Mark the todo as `[x]` in the checklist.
7. Add a log entry: `Promoted to assignment: build-auth-system/update-auth-error-messages`
8. Run rebuild for the target mission.

---

## 7. CLI Commands

All commands are under `syntaur todo`. Workspace is inferred from CWD or specified with `--workspace`.

| Command | Description |
|---------|-------------|
| `syntaur todo add "<description>" [--tags tag1,tag2]` | Add a new item to the checklist |
| `syntaur todo list [--tag <tag>] [--status open\|blocked\|done\|active]` | List items, optionally filtered |
| `syntaur todo start t:<id>` | Mark item as in-progress with current session ID |
| `syntaur todo complete t:<id> [--summary "..."]` | Mark done, write log entry |
| `syntaur todo block t:<id> --reason "..."` | Mark blocked, write log entry |
| `syntaur todo unblock t:<id>` | Return blocked item to open status |
| `syntaur todo delete t:<id>` | Remove item from checklist (no log entry) |
| `syntaur todo promote t:<id> [--mission <slug>]` | Convert to full assignment |
| `syntaur todo archive [--workspace <slug>]` | Manually trigger archiving |
| `syntaur todo log [t:<id>]` | Show log entries, optionally filtered to one item |
| `syntaur todo run t:<id> [t:<id> ...]` | Mark items in-progress and dispatch agent to work on them |
| `syntaur todo edit t:<id> "<new description>"` | Update item description |
| `syntaur todo tag t:<id> --add tag1 --remove tag2` | Modify tags on an item |

### `syntaur todo run`

This is the "go do these items" command. It:
1. Marks each item `[>:SESSION_ID]`
2. Reads the item descriptions
3. Feeds them to the agent as a task batch
4. As each item is completed, the agent marks it `[x]` and writes a log entry

When used conversationally (no CLI), the agent follows the same protocol: read the checklist, mark items in-progress, do the work, log, and check off.

---

## 8. API Endpoints

Base path: `/api/todos`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/todos/:workspace` | List all items in a workspace checklist |
| `POST` | `/api/todos/:workspace` | Add a new item |
| `GET` | `/api/todos/:workspace/:id` | Get a single item with its log entries |
| `PATCH` | `/api/todos/:workspace/:id` | Update status, description, or tags |
| `DELETE` | `/api/todos/:workspace/:id` | Delete an item |
| `POST` | `/api/todos/:workspace/:id/promote` | Promote to assignment |
| `POST` | `/api/todos/:workspace/:id/start` | Mark in-progress |
| `POST` | `/api/todos/:workspace/:id/complete` | Mark completed with log entry |
| `POST` | `/api/todos/:workspace/:id/block` | Mark blocked with reason |
| `POST` | `/api/todos/:workspace/:id/unblock` | Return to open |
| `GET` | `/api/todos/:workspace/log` | Get full log |
| `GET` | `/api/todos/:workspace/log/:id` | Get log entries for a specific item |
| `POST` | `/api/todos/:workspace/archive` | Trigger archive |

### Response Shape (list)

```json
{
  "workspace": "syntaur",
  "archiveInterval": "weekly",
  "items": [
    {
      "id": "a3f1",
      "description": "Fix broken link in README",
      "status": "open",
      "tags": ["docs"],
      "session": null
    },
    {
      "id": "b7c2",
      "description": "Add timeout to health check endpoint",
      "status": "in_progress",
      "tags": ["api"],
      "session": "d4e8f1a9"
    }
  ],
  "counts": {
    "open": 1,
    "in_progress": 1,
    "completed": 0,
    "blocked": 0,
    "total": 2
  }
}
```

---

## 9. Dashboard Views

### Global Todos Page

- Aggregated view across all workspaces
- Filter by workspace, tag, status
- Summary counts per workspace
- Ability to add, complete, block, delete, promote from the UI

### Workspace Todos Page

- Checklist view for a single workspace
- Inline status toggling (click to complete/block/start)
- Tag filtering
- Log panel (expandable per item or full log view)
- Promote button → opens assignment creation flow pre-filled

### Workspace Overview Integration

- Small "Quick Todos" card showing counts: `3 open · 1 in progress · 1 blocked`
- Links to the workspace todos page

---

## 10. Agent Protocol Guidance

Agents interacting with Quick Todos should follow these rules:

1. **Before starting work:** Read the checklist file. Verify the target items are `[ ]` (open) or `[!]` (blocked, if unblocking). Do not pick up items already marked `[>:...]` by another session.
2. **Claim items:** Change status to `[>:SESSION_ID]` using your current session ID before beginning work.
3. **On completion:** Change status to `[x]`. Append a log entry with session, branch, and summary.
4. **On blocking:** Change status to `[!]`. Append a log entry with the reason.
5. **Batch work:** When given multiple items, work through them sequentially. Update status and log after each item, not all at the end.
6. **Scope discipline:** If a todo turns out to require more than ~30 minutes of work or touches more than a handful of files, suggest promoting it to an assignment rather than continuing.
7. **Don't reorder items** in the checklist. Add new items at the bottom only.

---

## 11. Decisions

- **Conflict handling:** File-level locking will be needed. Agents may autonomously pick up todo items in the future, so the `[>:SESSION_ID]` marker alone isn't sufficient — a lock mechanism will prevent two agents from racing to claim the same item. Design TBD (could be a lockfile, filesystem advisory lock, or API-level optimistic concurrency).
- **Todo dependencies:** Deferred. Keeping it flat for v1. The log can describe relationships in prose.
- **Recurring todos:** Deferred for v1.
- **Global (non-workspace) todos:** Yes. A `_global.md` checklist (and `_global-log.md`) will exist in `~/.syntaur/todos/` for items that don't belong to any workspace. The CLI uses `--global` flag or omits `--workspace` when CWD doesn't map to a workspace. The API uses a reserved `:workspace` value of `_global`. Dashboard shows these on the global todos page.
