# File Ownership Rules

## Human-Authored (READ-ONLY for agents)

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |
| `templates/<id>/template.md` | `~/.syntaur/templates/` |

## Agent-Writable (YOUR ticket folder ONLY)

| File | Purpose |
|------|---------|
| `ticket.md` | Ticket record, source of truth for state |
| `plan*.md` | Versioned implementation plans |
| `scratchpad.md` | Working notes (legacy template) |

Path: `~/.syntaur/projects/<project>/tickets/<ID>-<slug>/`

Run `syntaur show` — edit only files listed with writer `agent`.

## CLI-Mediated (never edit directly)

| Mediator | Purpose |
|----------|---------|
| `syntaur log <id> -t <type> "body"` | Append to log role (`journal.md` on modern templates) |
| `syntaur progress log "<text>"` | Alias of `-t progress` |
| Dashboard **Journal** tab | Same semantics as `syntaur log` |

**Types:** `progress`, `decision`, `handoff`, `note`, `question`, `answer`, `review`

**Answer questions:** `syntaur log <id> -t answer "..." --answers <question-entry-iso>`

## Shared-Writable (any agent or human)

| Location | Purpose |
|----------|---------|
| `<project>/resources/<slug>.md` | Reference material |
| `<project>/memories/<slug>.md` | Learnings and patterns |

## Derived (NEVER edit)

- `manifest.md`, `_index-*.md`, `_status.md`

## Workspace Files

Source code within `workspace.worktree` / `workspace.repository` from ticket frontmatter.
