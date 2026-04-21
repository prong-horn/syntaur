# File Ownership Rules

## Human-Authored (READ-ONLY for agents)

Agents must NEVER modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |

## Agent-Writable (YOUR assignment folder ONLY)

You may ONLY write to files inside your assigned assignment folder:

| File | Purpose |
|------|---------|
| `assignment.md` | Assignment record, source of truth for state (includes `## Todos` checklist) |
| `plan*.md` | Versioned implementation plans (optional, 0 or more: `plan.md`, `plan-v2.md`, ...) — each linked from a todo in `assignment.md` |
| `progress.md` | Append-only timestamped progress log (newest first). Replaces the old `## Progress` body section. |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only handoff log |
| `decision-record.md` | Append-only decision log |

Path pattern (project-nested): `~/.syntaur/projects/<project>/assignments/<your-assignment>/`
Path pattern (standalone): `~/.syntaur/assignments/<your-assignment-uuid>/`

## CLI-Mediated Shared-Writable

Do NOT edit these files directly. Use the listed CLI commands:

| File | Mediator |
|------|----------|
| `comments.md` (any assignment) | `syntaur comment <slug-or-uuid> "body" [--type question\|note\|feedback] [--reply-to <id>]` |
| `## Todos` in another assignment's `assignment.md` (cross-assignment request) | `syntaur request <source> <target> "text"` |
| Question resolution | `PATCH /api/.../comments/:id/resolved` (dashboard) or toggle in dashboard UI |

These are bounded exceptions to the single-writer rule for assignment folders — the CLI serializes writes to avoid conflicts.

## Shared-Writable (any agent or human)

| Location | Purpose |
|----------|---------|
| `<project>/resources/<slug>.md` | Reference material |
| `<project>/memories/<slug>.md` | Learnings and patterns |

## Derived (NEVER edit)

All files prefixed with `_` are derived and rebuilt by tooling:
- `manifest.md`
- `_index-assignments.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`
- `resources/_index.md`
- `memories/_index.md`

## Workspace Files

When working on code (not protocol files), you may write to files within
the workspace defined in your assignment frontmatter:
- `workspace.worktreePath` or `workspace.repository` defines your project root
- You may create and edit source code files within that workspace
- The `.syntaur/context.json` context file in your working directory is also writable
