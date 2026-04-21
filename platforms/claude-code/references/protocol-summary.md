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
      _index-assignments.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      assignments/
        <assignment-slug>/
          assignment.md      # Agent-writable: source of truth for state (includes ## Todos checklist)
          plan*.md           # Agent-writable: versioned implementation plans (optional, 0 or more: plan.md, plan-v2.md, ...)
          progress.md        # Agent-writable, append-only: timestamped progress log
          comments.md        # CLI-mediated: threaded questions/notes/feedback (via `syntaur comment`)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only handoff log
          decision-record.md # Agent-writable: append-only decision log
      resources/
        _index.md            # Derived (read-only)
        <resource-slug>.md   # Shared-writable
      memories/
        _index.md            # Derived (read-only)
        <memory-slug>.md     # Shared-writable
  assignments/
    <assignment-id>/         # Standalone assignments — folder named by UUID, `project: null`
      assignment.md          # Same schema as project-nested, `slug` is display-only
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

## Assignment Lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started |
| `in_progress` | Actively being worked on |
| `blocked` | Manually blocked (requires `blockedReason`) |
| `review` | Work complete, awaiting review |
| `completed` | Done |
| `failed` | Could not be completed |

## Valid State Transitions

| From | Command | To |
|------|---------|-----|
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

1. **Assignment frontmatter is the single source of truth** for all assignment state.
2. **Project-nested assignments** live at `projects/<slug>/assignments/<aslug>/` (folder name = slug). **Standalone assignments** live at `assignments/<uuid>/` (folder name = UUID, `project: null`, slug display-only).
3. **Derived files** (underscore-prefixed) are never edited manually.
4. **Slugs** are lowercase, hyphen-separated.
5. **Dependencies** are declared via `dependsOn` in assignment frontmatter. Only valid within the same project — standalone assignments cannot declare `dependsOn`.
6. An assignment cannot transition from `pending` to `in_progress` while any dependency is not `completed`.
7. **Playbooks** in `~/.syntaur/playbooks/` define behavioral rules agents must follow. Read `manifest.md` for a summary, then read each referenced playbook before starting work.
8. **Todos** in the `## Todos` section of `assignment.md` are an informal markdown checklist. Items may be simple tasks or link to plan files. When a plan is superseded, mark the old todo: `- [x] ~~Execute [plan](./plan.md)~~ (superseded by plan-v2)` — never delete it. `## Todos` is also the landing spot for cross-assignment requests via `syntaur request`.
9. **Progress** is appended to `progress.md` as timestamped entries (newest first). Do not add a `## Progress` section to `assignment.md`.
10. **Comments** are appended to `comments.md` via `syntaur comment <slug> "body" [--type question|note|feedback] [--reply-to <id>]`. Never edit `comments.md` directly. Questions carry a `resolved` flag.
11. **Cross-assignment work** is requested via `syntaur request <source> <target> "text"` — appends to the target's `## Todos` annotated `(from: <source>)`.
