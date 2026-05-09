---
description: Register a project-level resource (link to dashboard, doc, ticket) under a Syntaur project
---

# /add-resource

Add a resource entry under `<projectDir>/resources/<slug>.md` and regenerate `_index.md` via the CLI. The agent never edits `_index.md` directly.

Follow the `add-resource` skill in full. Summary:

1. Resolve project from `.syntaur/context.json` or ask.
2. Gather `--name --source [--category --related-assignments --slug]`.
3. Run `syntaur resource add ...`.
4. Verify the slug file and refreshed index.
