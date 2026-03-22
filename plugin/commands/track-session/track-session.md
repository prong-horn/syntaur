---
name: track-session
description: Register, refresh, or remove a tmux session for server tracking in the Syntaur dashboard
arguments:
  - name: session
    description: "Tmux session name to track (or --refresh/--remove/--list flags)"
    required: false
---

# /track-session

Track a tmux session so its dev servers appear in the Syntaur dashboard.

## Usage

- `/track-session <session-name>` — Register a session and scan it
- `/track-session --refresh [session-name]` — Refresh one or all sessions
- `/track-session --remove <session-name>` — Stop tracking a session
- `/track-session --list` — List all tracked sessions

## Instructions

When the user runs this command, follow these steps based on the argument:

### Register (default — argument is a session name)

1. Verify the tmux session exists: run `tmux has-session -t <name>` via Bash
2. If it doesn't exist, tell the user and list available sessions with `tmux list-sessions -F '#{session_name}'`
3. Create the registration file at `~/.syntaur/servers/<sanitized-name>.md`:
   - Sanitize the name: replace any character that isn't alphanumeric, hyphen, or underscore with a hyphen
   - Write this content:
   ```
   ---
   session: <original-name>
   registered: <ISO timestamp>
   last_refreshed: <ISO timestamp>
   ---
   ```
4. Tell the user the session is now tracked and they can view it at the `/servers` page in the dashboard

### --refresh [session-name]

1. If a session name is given, update its `last_refreshed` timestamp in `~/.syntaur/servers/<name>.md`
2. If no session name, update all `.md` files in `~/.syntaur/servers/`
3. Tell the user to check the dashboard for updated scan data

### --remove <session-name>

1. Delete the file `~/.syntaur/servers/<sanitized-name>.md`
2. Confirm removal to the user

### --list

1. List all `.md` files in `~/.syntaur/servers/`
2. For each, read the `session` field from frontmatter and display it
3. If none exist, tell the user no sessions are being tracked
