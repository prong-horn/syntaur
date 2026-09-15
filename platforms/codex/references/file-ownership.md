# File Ownership Rules

## Human-Authored (READ-ONLY)

`project.md`, `templates/<id>/template.md`

## Agent-Writable

`ticket.md`, `plan*.md`, and any file `syntaur show` lists with writer `agent` in your ticket folder only.

## CLI-Mediated

| Command | Target |
|---------|--------|
| `syntaur log <id> -t <type> "body"` | Log role (`journal.md`) |
| `syntaur progress log "<text>"` | Alias for `-t progress` |

Types: progress, decision, handoff, note, question, answer, review.

## Derived (NEVER edit)

`manifest.md`, `_index-*.md`, `_status.md`
