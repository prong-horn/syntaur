# Syntaur Protocol Summary

Protocol version: **2.0**

## Directory Structure

```
~/.syntaur/
  config.md
  projects/
    <project-slug>/
      manifest.md            # Derived: root navigation (read-only)
      project.md             # Human-authored: project overview (read-only)
      _index-tickets.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      tickets/
        <ticket-id>/
          ticket.md      # Agent-writable: source of truth for state
          plan*.md           # Agent-writable: versioned implementation plans (optional, 0 or more: plan.md, plan-v2.md, ...)
          progress.md        # Agent-writable, append-only: timestamped progress log
          comments.md        # CLI-mediated: threaded questions/notes/feedback (via `syntaur comment`)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only cross-ticket outbound at completion
          decision-record.md # Agent-writable: append-only decision log
          sessions/
            <session-id>/
              summary.md     # Agent-writable: per-session continuity (single doc, overwritten)
      resources/
        _index.md            # Derived (read-only)
        <resource-slug>.md   # Shared-writable
      memories/
        _index.md            # Derived (read-only)
        <memory-slug>.md     # Shared-writable
  tickets/
    <ticket-id>/         # Standalone tickets — folder named by UUID, `project: null`
      ticket.md          # Same schema as project-nested, `slug` is display-only
      plan*.md
      progress.md
      comments.md
      scratchpad.md
      handoff.md
      decision-record.md
  playbooks/
    manifest.md              # Derived: playbook listing (read-only)
    <slug>.md                # User-authored: behavioral rules for agents
```

## Ticket Lifecycle

Run `syntaur show <id>` (or `syntaur show` with an open engagement) at the start of work and after every lifecycle verb. Follow **Stage** and **Next**.

### Stages

| Stage | Meaning |
|-------|---------|
| `backlog` | Not yet started; may be waiting on dependencies |
| `planning` | Shaping work and writing the plan |
| `ready` | Plan approved; ready to implement |
| `in_progress` | Actively being worked on |
| `review` | Work complete, awaiting review |
| `done` | Finished successfully |
| `dropped` | Abandoned or could not be completed |

### Flags (reason strings; stage unchanged)

| Field | Meaning |
|-------|---------|
| `blocked: "<reason>"` | Runtime obstacle requiring intervention |
| `parked: "<reason>"` | Intentionally paused |

### Lifecycle verbs

| Verb | Typical effect |
|------|----------------|
| `syntaur plan create` | Scaffold plan file; move toward `planning` |
| `syntaur approve` | `planning` → `ready` when gates pass |
| `syntaur start` | → `in_progress` |
| `syntaur review` | → `review` |
| `syntaur done` | → `done` |
| `syntaur drop` | → `dropped` |
| `syntaur reopen` | Reopen toward an earlier stage per template |
| `syntaur block` / `syntaur unblock` | Set or clear the `blocked` reason |
| `syntaur park` / `syntaur unpark` | Set or clear the `parked` reason |

## Key Rules

1. **Ticket frontmatter is the single source of truth** for all ticket state.
2. **Project-nested tickets** live at `projects/<slug>/tickets/<aslug>/` (folder name = slug). **Standalone tickets** live at `tickets/<uuid>/` (folder name = UUID, `project: null`, slug display-only).
3. **Derived files** (underscore-prefixed) are never edited manually.
4. **Slugs** are lowercase, hyphen-separated.
5. **Dependencies** are declared via `depends_on` in ticket frontmatter (ticket ids such as `UI-1`). Only valid within the same project — standalone tickets cannot declare `depends_on`.
6. A ticket cannot `start` while any dependency is not `done`.
7. **Playbooks** in `~/.syntaur/playbooks/` define behavioral rules agents must follow. Read `manifest.md` for a summary, then read each referenced playbook before starting work.
8. **Progress** is appended to `progress.md` as timestamped entries (newest first). Do not add a `## Progress` section to `ticket.md`.
9. **Comments** are appended to `comments.md` via `syntaur comment <id> "body" [--type question|note|feedback] [--reply-to <id>]`. Never edit `comments.md` directly. Questions carry a `resolved` flag.
10. On resume, read any open `handoff.md` (ticket-level cross-ticket outbound) plus `ticket.md` and the tail of `progress.md`. `syntaur session resume` surfaces the handoff path when present.
11. **Workspace** paths live under `workspace.repository` and `workspace.worktree` in ticket frontmatter.
