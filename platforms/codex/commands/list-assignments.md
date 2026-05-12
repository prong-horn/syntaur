---
description: List Syntaur assignments across projects with filters (status, project, tag, age)
---

# /list-assignments

Cross-project assignment listing via `syntaur ls`. Supports `--status`, `--project`, `--tag`, `--age`, `--json`. Different from the interactive `syntaur browse` TUI — emits scriptable output.

Follow the `list-assignments` skill in full. Summary:

1. Map user prose to `syntaur ls` flags (e.g. "pending" → `--status pending`, "this week" → `--age 7d`, "tagged X and Y" → `--tag X,Y`).
2. Run the CLI.
3. Present the table or pass the `--json` payload downstream.
