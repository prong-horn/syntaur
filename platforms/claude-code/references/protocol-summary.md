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
      _index-tickets.md      # Derived (read-only)
      _index-plans.md        # Derived (read-only)
      _index-decisions.md    # Derived (read-only)
      _status.md             # Derived (read-only)
      tickets/
        <ID>-<slug>/         # Folder name includes ticket id (<PREFIX>-<n>)
          ticket.md          # Kernel: source of truth for state
          plan*.md           # Agent-writable: versioned plans (optional)
          journal.md         # CLI-mediated log role (modern templates)
          chat/              # Chat notes when no log role; attachments
      resources/
        <resource-slug>.md   # Shared-writable
      memories/
        <memory-slug>.md     # Shared-writable
  templates/                 # Ticket template manifests
  playbooks/
    manifest.md              # Derived (read-only)
    <slug>.md                # User-authored behavioral rules
```

One-off tickets default to `projects/scratch/` (prefix `SCR`) when created via `syntaur new` without `--project`.

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
| `syntaur plan create` | Scaffold plan file; move toward `planning` (`--by` for audit attribution) |
| `syntaur approve` | `planning` → `ready` when gates pass |
| `syntaur start` | → `in_progress`; optional `--agent` one-use dispatch recipient; `--by` for audit attribution |
| `syntaur review` | → `review` |
| `syntaur done` | → `done` |
| `syntaur drop` | → `dropped` |
| `syntaur reopen` | Reopen toward an earlier stage per template |
| `syntaur block` / `syntaur unblock` | Set or clear the `blocked` reason |
| `syntaur park` / `syntaur unpark` | Set or clear the `parked` reason |

**Actor vs dispatch:** `--by <name>` on lifecycle verbs, plan create/version, and flag verbs attributes the action in the audit log (`human` by default). On `start` only, `--agent <id>` selects a one-use stage dispatch recipient — not audit attribution. `assign --agent`, `log --agent`, and `track-session --agent` keep their existing meanings.

**Stage handoff:** template stages may declare `agent` or `reviewer` with optional `auto`. Entering a stage may queue one exact-target dashboard turn (automatic when `auto: true`, or **Hand to** when manual). Ordinary chat stays available. `show` lists **Handoff:** (log) and **Agent:** (dispatch) separately. Reviewers log verdicts with `syntaur log -t review --agent <id> --verdict approve|changes --open high=<n>,medium=<n>` when the template allows.

## Key Rules

1. **Ticket frontmatter is the single source of truth** for all ticket state.
2. **Ticket folders** are `<ID>-<slug>` under `projects/<slug>/tickets/`.
3. **Derived files** (underscore-prefixed) are never edited manually.
4. **Dependencies** use `depends_on` ticket ids (`<PREFIX>-<n>`).
5. **Log role** entries append via `syntaur log -t <type>` — never edit `journal.md` directly.
6. **`syntaur progress log`** is an alias for `syntaur log -t progress`.
7. **Questions** use `syntaur log -t question`; answers use `-t answer --answers <question-ts>`.
8. On resume, read the latest `handoff` log entry (or legacy `handoff.md` until migrated) plus `ticket.md` and recent log tail. `syntaur session resume` surfaces handoff context.
9. **Legacy template** tickets may still have separate `progress.md`, `comments.md`, etc. — run `syntaur migrate journal` to merge into `journal.md`.
