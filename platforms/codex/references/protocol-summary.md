# Syntaur Protocol Summary

Protocol version: **2.0**

## Directory Structure

```
~/.syntaur/
  config.md
  projects/
    <project-slug>/
      manifest.md            # Derived (read-only)
      project.md             # Human-authored (read-only)
      _index-tickets.md      # Derived (read-only)
      tickets/
        <ID>-<slug>/
          ticket.md
          plan*.md           # Agent-writable (optional)
          journal.md         # CLI-mediated log role
          chat/
      resources/  memories/
  templates/  playbooks/
```

## Ticket Lifecycle

Run `syntaur show` at start and after every lifecycle verb. Follow **Stage** and **Next**.

Stages: `backlog` → `planning` → `ready` → `in_progress` → `review` → `done` | `dropped`. Flags: `blocked`, `parked`.

## Key Rules

1. Ticket frontmatter is canonical state.
2. Folders are `<ID>-<slug>`; ids are `<PREFIX>-<n>`.
3. Log entries via `syntaur log -t <type>` only — never edit `journal.md` directly.
4. `syntaur progress log` aliases `-t progress`.
5. Questions: `syntaur log -t question`; answers: `-t answer --answers <ts>`.
6. Legacy tickets: `syntaur migrate journal` merges old sidecars into `journal.md`.
