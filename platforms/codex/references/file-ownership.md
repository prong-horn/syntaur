# File Ownership Rules

## Human-Authored (Read-Only for Agents)

Agents must never modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |

## Agent-Writable (Your Assignment Folder Only)

You may only write to files inside your assigned assignment folder:

| File | Purpose |
|------|---------|
| `assignment.md` | Assignment record and source of truth for state (includes `## Todos` checklist) |
| `plan*.md` | Versioned implementation plans (optional, 0 or more: `plan.md`, `plan-v2.md`, ...) — each linked from a todo in `assignment.md` |
| `progress.md` | Append-only timestamped progress log (newest first). Replaces the old `## Progress` body section. |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

Path pattern (project-nested): `~/.syntaur/projects/<project>/assignments/<your-assignment>/`
Path pattern (standalone): `~/.syntaur/assignments/<your-assignment-uuid>/`

## CLI-Mediated Shared-Writable

Do not edit these files directly. Use the listed CLI commands:

| File | Mediator |
|------|----------|
| `comments.md` (any assignment) | `syntaur comment <slug-or-uuid> "body" [--type question\|note\|feedback] [--reply-to <id>]` |
| `## Todos` in another assignment's `assignment.md` (cross-assignment request) | `syntaur request <source> <target> "text"` |

These are bounded exceptions to the single-writer rule.

## Shared-Writable

| Location | Purpose |
|----------|---------|
| `<project>/resources/<slug>.md` | Reference material |
| `<project>/memories/<slug>.md` | Learnings and reusable patterns |

## Derived (Never Edit)

All files prefixed with `_` are derived and rebuilt by tooling:

- `manifest.md`
- `_index-assignments.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`
- `resources/_index.md`
- `memories/_index.md`

## Workspace Files

When working on code, you may write to files within the workspace defined in assignment frontmatter:

- `workspace.worktreePath` or `workspace.repository` defines the project root
- `.syntaur/context.json` in your current working directory is also writable
