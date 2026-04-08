---
name: "Workspace Before Code"
slug: workspace-before-code
description: "Set workspace fields in assignment.md before writing any implementation code"
when_to_use: "Before writing any implementation code for an assignment"
created: "2026-04-02T00:00:00Z"
updated: "2026-04-02T00:00:00Z"
tags:
  - protocol
  - setup
---

# Workspace Before Code

Before writing any implementation code, you MUST set the workspace fields in assignment.md frontmatter:

```yaml
workspace:
  repository: <absolute path to the repo you're working in>
  worktreePath: <absolute path if using a git worktree, otherwise null>
  branch: <branch name you're working on>
  parentBranch: <branch you branched from, usually main>
```

This is required because:
- The boundary enforcement hook reads these fields to know where you're allowed to write
- Without them, your edits outside the assignment directory will be blocked
- The dashboard uses these to link assignments to code

Run `pwd` and `git branch --show-current` to get the values. Set them before your first edit.
