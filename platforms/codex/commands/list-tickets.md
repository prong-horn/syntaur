---
description: List Syntaur tickets across projects with filters (status, project, tag, age)
---

# /list-tickets

Cross-project ticket listing via `syntaur ls`. Supports `--status`, `--project`, `--tag`, `--age`, `--json`. Emits scriptable output for automation.

Follow the `list-tickets` skill in full. Summary:

1. Map user prose to `syntaur ls` flags (e.g. "pending" → `--status pending`, "this week" → `--age 7d`, "tagged X and Y" → `--tag X,Y`).
2. Run the CLI.
3. Present the table or pass the `--json` payload downstream.
