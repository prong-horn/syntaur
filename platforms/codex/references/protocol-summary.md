# Syntaur Protocol Summary

## Directory Structure

```
~/.syntaur/
  config.md
  missions/
    <mission-slug>/
      manifest.md            # Derived: root navigation (read-only)
      mission.md             # Human-authored: mission overview (read-only)
      _index-assignments.md  # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      claude.md              # Human-authored: Claude-specific instructions (read-only)
      agent.md               # Human-authored: universal agent instructions (read-only)
      assignments/
        <assignment-slug>/
          assignment.md      # Agent-writable: source of truth for state (includes ## Todos checklist)
          plan*.md           # Agent-writable: versioned implementation plans (optional, 0 or more: plan.md, plan-v2.md, ...)
          scratchpad.md      # Agent-writable: working notes
          handoff.md         # Agent-writable: append-only handoff log
          decision-record.md # Agent-writable: append-only decision log
      resources/
        _index.md            # Derived (read-only)
        <resource-slug>.md   # Shared-writable
      memories/
        _index.md            # Derived (read-only)
        <memory-slug>.md     # Shared-writable
  playbooks/
    manifest.md              # Derived: playbook listing (read-only)
    <slug>.md                # User-authored: behavioral rules for agents
```

## Assignment Lifecycle

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

1. Assignment frontmatter is the single source of truth for assignment state.
2. One folder per mission and one subfolder per assignment.
3. Derived files are never edited manually.
4. Slugs are lowercase and hyphen-separated.
5. Dependencies are declared via `dependsOn` in assignment frontmatter.
6. An assignment cannot transition from `pending` to `in_progress` while any dependency is not `completed`.
7. The `## Todos` section in `assignment.md` is an informal markdown checklist. Items may be simple tasks or link to plan files. When a plan is superseded, mark the old todo: `- [x] ~~Execute [plan](./plan.md)~~ (superseded by plan-v2)` — never delete it.
8. Playbooks in `~/.syntaur/playbooks/` define behavioral rules agents must follow. Read `manifest.md` for a summary, then read each referenced playbook before starting work.
