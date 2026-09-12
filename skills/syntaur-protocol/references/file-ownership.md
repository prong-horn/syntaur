# File Ownership Rules (protocol v2.0)

## Human-Authored (READ-ONLY for agents)

Agents must NEVER modify these files:

| File | Location |
|------|----------|
| `project.md` | `<project>/project.md` |
| `CLAUDE.md` / `AGENTS.md` | Repo root (live outside `~/.syntaur/`) |
| `<slug>.md` | `~/.syntaur/playbooks/<slug>.md` |

Per-project `agent.md` / `claude.md` were removed in protocol v2.0. Agent-level conventions live at the repo root in `CLAUDE.md` / `AGENTS.md`, and user-defined behavioral rules live in `~/.syntaur/playbooks/`.

## Agent-Writable (YOUR ticket folder ONLY)

You may only write to files inside your currently-claimed ticket folder:

| File | Purpose |
|------|---------|
| `ticket.md` | Ticket record; source of truth for state. |
| `plan*.md` | Versioned implementation plans (`plan.md`, `plan-v2.md`, ...). Prior plan files are kept on disk as immutable history. |
| `progress.md` | Append-only, timestamped progress log (newest first). |
| `scratchpad.md` | Working notes. |
| `handoff.md` | Append-only handoff log. |
| `decision-record.md` | Append-only decision log (Status / Context / Decision / Consequences). |

Path patterns:
- Project-nested: `~/.syntaur/projects/<project>/tickets/<your-ticket-slug>/`
- Standalone: `~/.syntaur/tickets/<your-ticket-uuid>/` (folder name is the UUID; `slug` is display-only)

## CLI-Mediated (any agent via the `syntaur` CLI)

These files are never edited directly — write to them only through the CLI so derived indexes and dashboards stay consistent.

| Target | Command |
|--------|---------|
| `comments.md` (any ticket) | `syntaur comment <slug-or-uuid> "body" --type question\|note\|feedback [--reply-to <id>]` |

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
- `~/.syntaur/playbooks/manifest.md`

## Workspace Files

When working on code (not protocol files), you may write to files within the workspace defined in your ticket frontmatter:

- `workspace.worktreePath` or `workspace.repository` defines your code root.
- You may create and edit source files within that workspace.
- The `.syntaur/context.json` workspace-marker file in your working directory is also writable (merge, don't overwrite — the platform SessionStart hook may have populated `sessionId` and `transcriptPath`). It marks the workspace (repository/branch/worktree); it is not the active-ticket source of truth — the active ticket resolves from the session's open engagement.
