# File Ownership Rules

## Human-Authored (READ-ONLY for agents)

Agents must NEVER modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |

## Agent-Writable (YOUR ticket folder ONLY)

You may ONLY write to files inside your assigned ticket folder:

| File | Purpose |
|------|---------|
| `ticket.md` | Ticket record, source of truth for state |
| `plan*.md` | Versioned implementation plans (`plan.md`, `plan-v2.md`, ...). Prior plan files are kept on disk as immutable history. |
| `progress.md` | Append-only timestamped progress log (newest first). Replaces the old `## Progress` body section. |
| `scratchpad.md` | Working notes |
| `handoff.md` | Append-only **ticket-level cross-ticket outbound** at completion (written by `complete-ticket`) |
| `decision-record.md` | Append-only decision log |

Path pattern (project-nested): `~/.syntaur/projects/<project>/tickets/<your-ticket>/`
Path pattern (standalone): `~/.syntaur/tickets/<your-ticket-uuid>/`

## CLI-Mediated Shared-Writable

Do NOT edit these files directly. Use the listed CLI commands:

| File | Mediator |
|------|----------|
| `comments.md` (any ticket) | `syntaur comment <ticket-id> "body" [--type question\|note\|feedback] [--reply-to <id>]` |
| Question resolution | `PATCH /api/.../comments/:id/resolved` (dashboard) or toggle in dashboard UI |

These are bounded exceptions to the single-writer rule for ticket folders — the CLI serializes writes to avoid conflicts.

## Shared-Writable (any agent or human)

| Location | Purpose |
|----------|---------|
| `<project>/resources/<slug>.md` | Reference material |
| `<project>/memories/<slug>.md` | Learnings and patterns |

## Derived (NEVER edit)

All files prefixed with `_` are derived and rebuilt by tooling:
- `manifest.md`
- `_index-tickets.md`
- `_index-plans.md`
- `_index-decisions.md`
- `_status.md`

## Workspace Files

When working on code (not protocol files), you may write to files within
the workspace defined in your ticket frontmatter:
- `workspace.worktree` or `workspace.repository` defines your project root
- You may create and edit source code files within that workspace
- The `.syntaur/context.json` context file in your working directory is also writable
