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
  "0:1": { mission: "auth-redesign", assignment: "implement-oauth" }
---
```

The file body is empty. The file acts as a registration record. Overrides store manual assignment links keyed by `windowIndex:paneIndex`.

Session names are sanitized for use as filenames: only alphanumeric characters, hyphens, and underscores are allowed. Dots, colons, and other special characters are replaced with hyphens.

### API Response Types

```typescript
interface TrackedSession {
  name: string;
  registered: string;
  lastRefreshed: string;      // from file — time of last explicit refresh
  scannedAt: string;          // current scan time — when this data was collected
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
  urls: string[];             // always http://localhost:<port>
  assignment: {
    mission: string;
    slug: string;
    title: string;
  } | null;
}

interface ServersResponse {
  sessions: TrackedSession[];
  tmuxAvailable: boolean;     // false if tmux binary not found
}
```

URLs are always constructed as `http://localhost:<port>`. No attempt is made to detect HTTPS or non-localhost bindings.

### Directory Setup

The `~/.syntaur/servers/` directory is created lazily by the API on first write (ensureDir pattern), not by `syntaur init`. This avoids requiring an init update for an optional feature.

## Discovery & Scanning

When a refresh is triggered, the server executes these steps:

1. **Check tmux availability:** `which tmux` — if not found, return `{ sessions: [], tmuxAvailable: false }` and the dashboard shows a "tmux not installed" state.
2. **Verify session exists:** `tmux has-session -t <name>` — if not found, mark `alive: false` and skip scanning.
3. **List all panes:** `tmux list-panes -s -t <name> -F '#{window_index}|#{window_name}|#{pane_index}|#{pane_current_command}|#{pane_current_path}|#{pane_pid}'`
4. **Git info per unique working directory:**
   - `git -C <cwd> rev-parse --abbrev-ref HEAD` (branch)
   - `git -C <cwd> rev-parse --git-common-dir` (detect worktree — if the output is an absolute path pointing outside the cwd's own `.git`, then `worktree = true`)
5. **Ports per pane PID:** Run `lsof -i -P -n -sTCP:LISTEN` once for all PIDs, then filter. To find all relevant PIDs, recursively walk the process tree using `pgrep -P <pid>` starting from the pane PID, up to 4 levels deep. This catches shell → npm → node chains.
6. **Auto-link to assignments:** For each pane, compare its resolved absolute `cwd` against all assignments' `workspace.worktreePath` (exact match after path normalization — resolve symlinks, remove trailing slashes). If no path match, fall back to matching `branch` against `workspace.branch`. If multiple assignments match, prefer the one whose `workspace.worktreePath` matches (path is more specific than branch). Manual overrides from frontmatter always take precedence over auto-linking.

### Caching

`GET` endpoints return cached scan results with a 10-second TTL. Within the TTL, repeated GETs return the same data without re-scanning. `POST /refresh` always bypasses the cache, performs a fresh scan, updates `last_refreshed` in the file, and repopulates the cache.

All scanning runs server-side in the Express API.

## Slash Command

**`/track-session`** — a Syntaur plugin slash command (not a CLI subcommand). Lives in `plugin/commands/track-session.md`.

```
/track-session <tmux-session-name>        # register and scan
/track-session --refresh [session-name]   # re-scan one or all
/track-session --remove <session-name>    # unregister
/track-session --list                     # list all tracked
```

Creates/removes markdown files under `~/.syntaur/servers/` and calls the dashboard API for initial scan (if the dashboard is running).

## API Endpoints

```
GET    /api/servers                                            → ServersResponse with cached scan data
GET    /api/servers/:name                                      → single TrackedSession with cached scan data
POST   /api/servers                                            → register a session { name: string }
DELETE /api/servers/:name                                      → unregister (delete file)
POST   /api/servers/refresh                                    → fresh scan all sessions, update cache
POST   /api/servers/:name/refresh                              → fresh scan one session, update cache
PATCH  /api/servers/:name/panes/:windowIndex/:paneIndex/assignment → manual assignment link
       body: { mission: string, assignment: string } | null
```

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
- **Tmux not installed state:** If `tmuxAvailable: false`, show an informational message instead of the session list.

### Contextual Integration

- **Assignment Detail:** New "Servers" section below workspace info showing panes linked to this assignment (command, ports/URLs, session name). Only rendered if linked servers exist.
- **Overview:** New "Active Servers" stat card with count of tracked sessions (with dead count as warning indicator) and total listening ports. Clicks through to `/servers`.
- **Attention:** Dead sessions (tmux gone but still registered) surface as low-priority attention items.

### Data Hooks

```typescript
useServers()       → GET /api/servers      (scope: 'servers')
useServer(name)    → GET /api/servers/:name (scope: 'servers')
```

Follow existing `useFetch` + WebSocket pattern. The `WebSocketScope` type union and `WsMessageType` must be extended with `'servers'` / `'servers-updated'`.

## File Watcher & WebSocket

Extend the existing file watcher to also watch `~/.syntaur/servers/`. This requires:

- Adding an optional `serversDir` to `WatcherOptions` and creating a second chokidar instance (or watching the parent `~/.syntaur/` with path filtering).
- Adding `'servers-updated'` to the `WsMessageType` union in `types.ts`.
- The watcher's `handleChange` logic for server files is simpler than mission files — just broadcast `{ type: 'servers-updated' }` on any change, no slug extraction needed.
- Adding a `serversDir()` helper to `src/utils/paths.ts` (returns `syntaurRoot() + '/servers'`).
- Adding `serversDir` to `DashboardServerOptions`.

On file create/delete/modify in `~/.syntaur/servers/`, broadcast `{ type: 'servers-updated' }` via WebSocket. Frontend hooks refetch on this message.

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
