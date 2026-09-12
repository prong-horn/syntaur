---
name: syntaur-protocol
description: >-
  Use when the user mentions Syntaur, projects, tickets, files under
  ~/.syntaur/, ticket.md, plan*.md, progress.md, comments.md, handoff.md,
  .syntaur/context.json, lifecycle states, or write boundaries. Core protocol
  knowledge for any AI agent working within Syntaur (protocol v2.0).
license: MIT
metadata:
  author: prong-horn
  version: "1.1.0"
---

# Syntaur Protocol (v2.0)

You are working within the Syntaur protocol — a coordination system for AI agents built on markdown files. Follow these rules at all times.

## Write Boundary Rules

Respect file ownership boundaries. The Codex plugin enforces them with a PreToolUse hook; Claude Code and every other harness are on the honor system, and the dashboard surfaces violations.

### Files you may write

1. **Your ticket folder only** (project-nested OR standalone):
   - `ticket.md`
   - `plan*.md` (versioned — `plan.md`, `plan-v2.md`, etc.)
   - `progress.md` (append-only, timestamped)
   - `scratchpad.md`
   - `handoff.md` (append-only)
   - `decision-record.md` (append-only)
2. **Project-level shared files:**
   - `~/.syntaur/projects/<project>/resources/<slug>.md`
   - `~/.syntaur/projects/<project>/memories/<slug>.md`
3. **Workspace files** inside the ticket's configured `workspace.worktreePath` / `workspace.repository`.
4. **Workspace marker:** `.syntaur/context.json` in the current working directory (repository/branch/worktree markers plus legacy session bookkeeping — not the active-ticket source of truth).

### Files written only via CLI (never edit directly)

- `comments.md` (any ticket) — use `syntaur comment <ticket-id> "body" --type question|note|feedback [--reply-to <id>]`. Questions carry a `resolved` flag toggled in the dashboard.

### Files you must never write

1. `project.md` — human-authored, read-only.
2. `manifest.md` — derived, rebuilt by tooling.
3. Any file prefixed with `_` (`_index-*.md`, `_status.md`) — derived.
4. Other agents' ticket folders (except via the CLI-mediated channels above).
5. Anything outside the current workspace boundary.

Per-project `agent.md` / `claude.md` do NOT exist in protocol v2.0. Agent-level conventions now live at the repo root (`CLAUDE.md` / `AGENTS.md`) and in `~/.syntaur/playbooks/`.

## Current Ticket Context

The **active ticket** is resolved from the session's OPEN engagement — the ticket this session is currently bound to (established by `syntaur track-session`). It is NOT read from `.syntaur/context.json`. To learn the active ticket, run `syntaur session resume` (or `--json`); to bind a different one, `grab-ticket` (which calls `track-session`).

`.syntaur/context.json` is a WORKSPACE MARKER file — it identifies the workspace directory and may carry legacy session bookkeeping. It is NOT authoritative for the active ticket. Read it for workspace markers; do NOT treat `projectSlug` / `ticketSlug` / `ticketDir` as the active-ticket source of truth (any such scalars are non-authoritative legacy hints). Fields you may see:

- `repository` — workspace repository (path or remote URL)
- `branch` — workspace branch, if known
- `worktreePath` — absolute path to the worktree, if this workspace is a worktree
- `workspaceRoot` — absolute path to the code workspace
- `sessionId` — real agent-runtime session id (legacy hint; never a synthesized UUID, and a co-tenant can clobber it — not authoritative for identity)
- `transcriptPath` — absolute path to the agent's rollout/transcript file, if known

## Required Reading Order

When starting work on an existing ticket, read these in order:

1. `~/.syntaur/playbooks/*.md` — behavioral rules (take precedence over defaults)
2. `<projectDir>/manifest.md` (skip for standalone)
3. `<projectDir>/project.md` (skip for standalone)
4. `<ticketDir>/ticket.md`
5. `<ticketDir>/comments.md` if present — inherited questions / notes
6. Latest `<ticketDir>/plan*.md` (pick the newest)
7. `<ticketDir>/handoff.md` — history
8. For each `dependsOn` entry: the dependency's `handoff.md` AND `decision-record.md` — upstream integration context and accepted decisions carry forward

## Lifecycle Commands

- `syntaur assign <id> --agent <name> --project <project>` — set assignee
- `syntaur start <id> --project <project>` — pending → in_progress
- `syntaur review <id> --project <project>` — in_progress → review
- `syntaur complete <id> --project <project>` — in_progress/review → completed
- `syntaur block <id> --project <project> --reason <text>` — block
- `syntaur unblock <id> --project <project>` — unblock
- `syntaur fail <id> --project <project>` — mark as failed
- `syntaur new "<title>" [--type <type>] [--project <slug>]` — create in a project (defaults to `scratch` / `SCR-<n>` when `--project` is omitted)
- `syntaur comment <ticket-id> "body" --type question|note|feedback [--reply-to <id>]` — append to `comments.md`
- `syntaur track-session --agent <name> --session-id <real-id> [--transcript-path <path>] [--project <p>] [--ticket <id>]` — register an agent session. The session-id must be the real one from the agent runtime — no synthesized UUIDs.

## Agent Sessions

Sessions are registered in `~/.syntaur/syntaur.db` keyed on the real agent session id. Plugins for Claude Code / Codex include a `SessionStart` hook that auto-merges `sessionId` and `transcriptPath` into an existing `.syntaur/context.json` at the start of every session. Other agents should source the real id from their runtime and pass it to `syntaur track-session` explicitly.

## Playbooks

Playbooks at `~/.syntaur/playbooks/` are user-defined behavioral rules. Read them before starting work on any ticket and follow their directives. They take precedence over default conventions when they conflict.

```bash
ls ~/.syntaur/playbooks/*.md 2>/dev/null
```

## Conventions

- Ticket frontmatter is the single source of truth for state. `project` is the containing project slug (`null` for standalone); `type` is a classification validated against `config.md` `types.definitions` when present.
- Slugs are lowercase, hyphen-separated. For standalone tickets the folder is named by UUID; `slug` is display-only.
- Update acceptance criteria checkboxes as work lands, not only at the end.
- Append milestones to `progress.md` — do NOT add a `## Progress` section to `ticket.md` (v2.0 moved progress to its own file).
- Record questions / notes / feedback via `syntaur comment` — never edit `comments.md` directly. Do NOT set status to `blocked` just because there is an open question; block only for a real external dependency with a `--reason`.
- Write handoffs with enough context for another agent or human to continue cleanly. Record decisions in `decision-record.md` with Status / Context / Decision / Consequences — downstream dependents auto-load these during grab.
- Commit frequently with messages referencing the ticket slug.

## References

For the full directory structure, lifecycle state table, and detailed file ownership rules, read:

- `references/protocol-summary.md`
- `references/file-ownership.md`
