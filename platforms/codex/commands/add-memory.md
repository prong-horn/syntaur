---
description: Capture a project-level Syntaur memory under <projectDir>/memories/ via the CLI
---

# /add-memory

Add a project-scoped memory entry. Writes `<projectDir>/memories/<slug>.md` and regenerates `_index.md` server-side via `syntaur memory add` — the agent never touches `_index.md` directly per the file-ownership protocol.

Follow the `add-memory` skill in full. Summary:

1. Resolve project from `.syntaur/context.json` or ask.
2. Gather `--name --source [--scope --source-assignment --related-assignments --slug]`.
3. Run `syntaur memory add ...`.
4. Optionally edit the body of the new file to flesh out content.

Distinct from the user-global Claude Code auto-memory at `~/.claude/projects/<...>/memory/`.
