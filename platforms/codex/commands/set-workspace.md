---
description: Populate the four workspace.* fields in the active assignment.md per the Workspace Before Code playbook
---

# /set-workspace

Write `repository`, `worktreePath`, `branch`, `parentBranch` into the assignment.md frontmatter. Validates the file via `syntaur doctor --assignment <path> --json` before writing — refuses to touch a malformed file.

Follow the `set-workspace` skill in full. Summary:

1. Read `.syntaur/context.json` to find `assignmentDir`.
2. Run `syntaur doctor --assignment <path> --json`. Refuse on `ok: false`.
3. Auto-detect defaults from `git rev-parse` when not supplied; ask user for missing fields.
4. Replace the four `workspace:` block lines and bump the top-level `updated` timestamp.
5. Re-validate via `doctor --assignment`. Restore on post-write failure.
