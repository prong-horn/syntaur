---
name: track-session
description: Use when the user asks to track, register, or log this Claude Code session in the Syntaur dashboard — standalone or linked to a project/assignment. Triggers on "/track-session", "track this session", "register this session in syntaur", or similar.
---

# Track Session

Attach a description and/or a project+assignment link to the current agent session's row in the Syntaur dashboard.

Plain registration is automatic now — the SessionStart hook registers every session (and the background scanner backfills any the hook missed), so this skill only matters for the one remaining manual case: adding a description or an explicit project/assignment link. The CLI self-resolves the calling session's id (env → process-tree markers → transcript scan); never pass a synthesized id.

## Usage

User arguments: `$ARGUMENTS`

- (no args) — upsert the session row as-is (rarely needed; the hook already did this)
- `--description "<text>"` — attach a description
- `--project <slug> --assignment <slug>` — link to a project assignment
- `--description "<text>" --project <slug> --assignment <slug>` — both

## Workflow

Run one Bash call (use `dangerouslyDisableSandbox: true` since it writes to `~/.syntaur/`), passing through whatever optional flags the user gave:

```bash
syntaur track-session --agent claude \
  [--description "<text>"] \
  [--project <slug>] [--assignment <slug>]
```

The CLI resolves the session id, transcript-derived path, owning pid, and HEAD sha itself, and prints one of:

- `Registered standalone agent session <sessionId>.`
- `Registered agent session <sessionId> for <assignment> in <project>.`

Registration is idempotent — re-running with the same session id safely upserts the description/link onto the existing row.

If it errors with "Could not resolve a session id", restart the Claude session so the SessionStart hook can register it (or pass `--session-id <id>` with a real agent-generated id — never synthesize one).

Confirm to the user: the row was updated (include the short session id), it auto-stops at SessionEnd, and which project/assignment it is linked to, if any.
