# File Ownership Rules

- **Agent-writable:** `ticket.md`, `plan*.md`, and files `syntaur show` lists with writer `agent`.
- **CLI-mediated:** log role (`journal.md`) via `syntaur log -t <type> "body"` — never edit directly.
- **Human / derived:** `project.md`, `manifest.md`, `_index-*`, `_status.md` — read only.

Answer open questions: `syntaur log <id> -t answer "..." --answers <question-entry-iso>`.
