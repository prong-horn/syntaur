# File Ownership Rules

## Human-Authored (Read-Only for Agents)

Agents must never modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |

## Agent-Writable (Your Ticket Folder Only)

You may only write to files inside your assigned ticket folder:

| File | Purpose |
|------|---------|
| `ticket.md` | Ticket record and source of truth for state |
| `plan*.md` | Versioned implementation plans (`plan.md`, `plan-v2.md`, ...). Prior plan files are kept on disk as immutable history. |
| `progress.md` | Append-only timestamped progress log (newest first). Replaces the old `## Progress` body section. |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only **ticket-level cross-ticket outbound** at completion (written by `complete-ticket`) |
| `decision-record.md` | Append-only decision log |

Path pattern (project-nested): `~/.syntaur/projects/<project>/tickets/<your-ticket>/`
Path pattern (standalone): `~/.syntaur/tickets/<your-ticket-uuid>/`

## CLI-Mediated Shared-Writable

Do not edit these files directly. Use the listed CLI commands:

| File | Mediator |
|------|----------|
| `comments.md` (any ticket) | `syntaur comment <ticket-id> "body" [--type question\|note\|feedback] [--reply-to <id>]` |

These are bounded exceptions to the single-writer rule.

## Shared-Writable

| Location | Purpose |
|----------|---------|
| `<project>/resources/<slug>.md` | Reference material |
| `<project>/memories/<slug>.md` | Learnings and reusable patterns |

## Derived (Never Edit)

All files prefixed with `_` are derived and rebuilt by tooling:

- `manifest.md`
- `_index-tickets.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`

## Workspace Files

When working on code, you may write to files within the workspace defined in ticket frontmatter:

- `workspace.worktreePath` or `workspace.repository` defines the project root
- `.syntaur/context.json` in your current working directory is also writable
