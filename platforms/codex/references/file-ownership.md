# File Ownership Rules

## Human-Authored (Read-Only for Agents)

Agents must never modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |
| `agent.md` | `<project>/agent.md` |
| `claude.md` | `<project>/claude.md` |

## Agent-Writable (Your Assignment Folder Only)

You may only write to files inside your assigned assignment folder:

| File | Purpose |
|------|---------|
| `assignment.md` | Assignment record and source of truth for state (includes `## Todos` checklist) |
| `plan*.md` | Versioned implementation plans (optional, 0 or more: `plan.md`, `plan-v2.md`, ...) — each linked from a todo in `assignment.md` |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

Path pattern: `~/.syntaur/projects/<project>/assignments/<your-assignment>/`

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
