---
name: track-server
description: Use when the user wants to register, refresh, remove, or list tracked tmux dev-server sessions for the Syntaur dashboard. Triggers on "/track-server", "track this server", "register this dev server", or similar — distinct from /track-session which registers Claude Code agent sessions.
---

# Track Server

Track tmux sessions so their development servers show up in the Syntaur dashboard. Distinct from `/track-session`, which registers Claude Code agent sessions.

## Arguments

User arguments: `$ARGUMENTS`

Supported forms:

- `<session-name>`
- `--refresh [session-name]`
- `--remove <session-name>`
- `--list`

## Workflow

### Register

1. Verify the tmux session exists with `tmux has-session -t <name>`.
2. If it does not exist, list available sessions with `tmux list-sessions -F '#{session_name}'`.
3. Create `~/.syntaur/servers/<sanitized-name>.md` with frontmatter:

```yaml
---
session: <original-name>
registered: <ISO timestamp>
last_refreshed: <ISO timestamp>
---
```

4. Tell the user the session is now tracked.

### Refresh

1. Update `last_refreshed` for the named session, or for every file in `~/.syntaur/servers/` when no name was provided.

### Remove

1. Delete `~/.syntaur/servers/<sanitized-name>.md`.

### List

1. List all tracked session markdown files and show the `session` field from each.
