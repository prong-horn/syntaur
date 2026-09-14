---
description: Populate the four workspace.* fields in the active ticket.md per the Workspace Before Code playbook
---

# /set-workspace

Write `repository`, `worktree`, `branch`, `parentBranch` into the ticket.md frontmatter. Validates the file via `syntaur doctor --ticket <path> --json` before writing — refuses to touch a malformed file.

Follow the `set-workspace` skill in full. Summary:

1. Read `.syntaur/context.json` to find `ticketDir`.
2. Run `syntaur doctor --ticket <path> --json`. Refuse on `ok: false`.
3. Auto-detect defaults from `git rev-parse` when not supplied; ask user for missing fields.
4. Replace the four `workspace:` block lines and bump the top-level `updated` timestamp.
5. Re-validate via `doctor --ticket`. Restore on post-write failure.
