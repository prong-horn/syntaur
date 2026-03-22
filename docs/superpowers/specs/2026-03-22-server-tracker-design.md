# Server Tracker — Design Spec

Track locally running dev servers across tmux sessions, showing which branches/worktrees they run on, which ports they listen on, and which Syntaur assignments they belong to.

## Problem

When developing on multiple branches simultaneously with multiple dev servers running, it's hard to keep track of which URLs go to which codebase, which branch is running where, and which assignment each server relates to.

## Solution

A Syntaur-native feature that lets you register tmux sessions for tracking. On demand, Syntaur scans the registered sessions to discover running processes, ports, git branches, and worktree info — then auto-links servers to assignments where possible. All of this is visible in the dashboard.

## Data Model

### Session Files

Each tracked tmux session gets a markdown file at `~/.syntaur/servers/<session-name>.md`:

```yaml
---
session: my-feature-stack
registered: 2026-03-22T14:30:00Z
last_refreshed: 2026-03-22T14:35:00Z
overrides:
  "0.1": { mission: "auth-redesign", assignment: "implement-oauth" }
---
```

The file body is empty. The file acts as a registration record. Overrides store manual assignment links keyed by `windowIndex.paneIndex`.

### API Response Types

```typescript
interface TrackedSession {
  name: string;
  registered: string;
  lastRefreshed: string;
  alive: boolean;
  windows: TrackedWindow[];
}

interface TrackedWindow {
  index: number;
  name: string;
  panes: TrackedPane[];
}

interface TrackedPane {
  index: number;
  command: string;
  cwd: string;
  branch: string | null;
  worktree: boolean;
  ports: number[];
  urls: string[];
  assignment: {
    mission: string;
    slug: string;
    title: string;
  } | null;
}
```

## Discovery & Scanning

When a refresh is triggered, the server executes these steps:

1. **Verify session exists:** `tmux has-session -t <name>`
2. **List all panes:** `tmux list-panes -s -t <name> -F '#{window_index}|#{window_name}|#{pane_index}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}'`
3. **Git info per unique working directory:**
   - `git -C <cwd> rev-parse --abbrev-ref HEAD` (branch)
   - `git -C <cwd> rev-parse --git-common-dir` (detect worktree)
4. **Ports per pane PID:** `lsof -i -P -n -sTCP:LISTEN` filtered by pane PID and its child processes (`pgrep -P <pid>`)
5. **Auto-link to assignments:** Match pane `cwd`/`branch` against assignment `workspace.worktreePath`/`workspace.branch`. Manual overrides from frontmatter take precedence.

All scanning runs server-side in the Express API. Only `last_refreshed` is written back to the session file.

## Slash Command

**`/track-session`**

```
/track-session <tmux-session-name>        # register and scan
/track-session --refresh [session-name]   # re-scan one or all
/track-session --remove <session-name>    # unregister
/track-session --list                     # list all tracked
```

Creates/removes markdown files under `~/.syntaur/servers/` and calls the API for initial scan.

## API Endpoints

```
GET    /api/servers                              → all tracked sessions with live scan data
GET    /api/servers/:name                        → single session with live scan data
POST   /api/servers                              → register a session { name: string }
DELETE /api/servers/:name                        → unregister (delete file)
POST   /api/servers/refresh                      → re-scan all sessions
POST   /api/servers/:name/refresh                → re-scan one session
PATCH  /api/servers/:name/panes/:id/assignment   → manual assignment link
       body: { mission: string, assignment: string } | null
```

`GET` endpoints perform live tmux/lsof scanning on each call. `refresh` endpoints also update `last_refreshed` in the file.

## Dashboard UI

### New Page: `/servers`

Top-level page in sidebar nav. Card-based layout:

- **Session card header:** Session name, alive/dead status badge, last refreshed timestamp, refresh button, remove button.
- **Window sections:** Window name/index as subheader.
- **Pane rows:** Each pane shows:
  - Running command (e.g., `npm run dev`)
  - Working directory (shortened)
  - Branch name with worktree indicator
  - Listening ports as clickable `http://localhost:XXXX` links
  - Linked assignment as clickable badge navigating to assignment detail, or "unlinked" state with manual link button.
- **Top bar:** "Track Session" button (form to enter tmux session name), "Refresh All" button.

### Contextual Integration

- **Assignment Detail:** New "Servers" section below workspace info showing panes linked to this assignment (command, ports/URLs, session name). Only rendered if linked servers exist.
- **Overview:** New "Active Servers" stat card with count of tracked sessions and total listening ports. Clicks through to `/servers`.
- **Attention:** Dead sessions (tmux gone but still registered) surface as low-priority attention items.

### Data Hooks

```typescript
useServers()       → GET /api/servers      (scope: 'servers')
useServer(name)    → GET /api/servers/:name (scope: 'servers')
```

Follow existing `useFetch` + WebSocket pattern.

## File Watcher & WebSocket

Extend the existing file watcher to also watch `~/.syntaur/servers/`. On file create/delete/modify, broadcast `{ type: 'servers-updated' }` via WebSocket. Frontend hooks refetch on this message.

Live scan data (tmux state, ports) is not file-driven — it comes from shell commands at request time. WebSocket only signals changes to the set of tracked sessions, not server state changes. Server state updates happen via the refresh action.

## Lifecycle

- **Registration:** `/track-session <name>` creates the file and does initial scan.
- **Refresh:** Manual via slash command (`--refresh`) or dashboard button. Re-scans tmux and updates data.
- **Auto-cleanup:** On refresh, if a tmux session no longer exists, mark `alive: false`. Dead sessions appear in the attention page.
- **Manual removal:** `/track-session --remove <name>` or dashboard remove button deletes the file.

## Future Considerations (not in scope)

- Periodic auto-polling (upgrade from manual refresh)
- Auto-discovery of tmux sessions without explicit registration
- Process health monitoring (restart detection, crash alerts)
