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

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started |
| `in_progress` | Actively being worked on |
| `blocked` | Manually blocked and requires `blockedReason` |
| `review` | Work complete and awaiting review |
| `completed` | Done |
| `failed` | Could not be completed |

## Valid State Transitions

| From | Command | To |
|------|---------|----|
| pending | start | in_progress |
| pending | block | blocked |
| in_progress | block | blocked |
| in_progress | review | review |
| in_progress | complete | completed |
| in_progress | fail | failed |
| blocked | unblock | in_progress |
| review | start | in_progress |
| review | complete | completed |
| review | fail | failed |

## Key Rules

1. Ticket frontmatter is the single source of truth for ticket state.
2. Project-nested tickets live at `projects/<slug>/tickets/<aslug>/` (folder = slug). Standalone tickets live at `tickets/<uuid>/` (folder = UUID, `project: null`, slug display-only).
3. Derived files are never edited manually.
4. Slugs are lowercase and hyphen-separated.
5. Dependencies are declared via `dependsOn` in ticket frontmatter. Only valid within the same project.
6. A ticket cannot transition from `pending` to `in_progress` while any dependency is not `completed`.
7. Playbooks in `~/.syntaur/playbooks/` define behavioral rules agents must follow. Read `manifest.md` for a summary, then read each referenced playbook before starting work.
8. Progress is appended to `progress.md` as timestamped entries (newest first). Do not add a `## Progress` section to `ticket.md`.
9. Comments are appended to `comments.md` via `syntaur comment <slug> "body" [--type question|note|feedback] [--reply-to <id>]`. Never edit `comments.md` directly.
10. On resume, read any open `handoff.md` (ticket-level cross-ticket outbound) plus `ticket.md` and the tail of `progress.md`. `syntaur session resume` surfaces the handoff path when present.
