---
description: Register, refresh, remove, or list tracked tmux sessions for the Syntaur dashboard.
---

# /track-session

Track a tmux session so its dev servers appear in the Syntaur dashboard.

## Usage

- `/track-session <session-name>` - register a session and scan it
- `/track-session --refresh [session-name]` - refresh one or all sessions
- `/track-session --remove <session-name>` - stop tracking a session
- `/track-session --list` - list tracked sessions

## Workflow

1. Prefer the `track-session` skill logic for all variants.
2. For register:
   - verify the tmux session exists
   - create or update `~/.syntaur/servers/<sanitized-name>.md`
3. For refresh:
   - update `last_refreshed`
4. For remove:
   - delete the registration file
5. For list:
   - show tracked sessions pulled from frontmatter
