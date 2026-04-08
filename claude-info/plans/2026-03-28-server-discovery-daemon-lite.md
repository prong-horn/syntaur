# Server Autodiscovery Daemon (Revised)

**Date:** 2026-03-28
**Complexity:** medium
**Tech Stack:** TypeScript (Node 20+, ESM), Express 5, WebSocket (ws), Chokidar, Vitest

## Objective
Add a background polling daemon to the dashboard server that automatically discovers and tracks tmux sessions and non-tmux processes whose working directories or branches match Syntaur assignment workspaces, registering them as tracked servers with `auto: true` and `kind: 'tmux' | 'process'` in their frontmatter.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/types.ts` | MODIFY | Add `auto`, `kind`, and process metadata fields to `SessionFileData` |
| `src/dashboard/scanner.ts` | MODIFY | Export 7 private functions; add process-kind scanning path to `scanAllSessions` |
| `src/dashboard/servers.ts` | MODIFY | Add `auto`/`kind` field support to all file read/write paths |
| `src/dashboard/autodiscovery.ts` | CREATE | Core daemon: polling, tmux enumeration, process discovery, reconciliation |
| `src/dashboard/server.ts` | MODIFY | Wire daemon lifecycle into `start()` (line 206) / `stop()` (line 231) |
| `src/__tests__/autodiscovery.test.ts` | CREATE | Tests for discovery, reconciliation, field preservation, per-kind cleanup |

## Tasks

### 1. Extend `SessionFileData` type with `auto`, `kind`, and process metadata
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add to the `SessionFileData` interface (currently lines 339-344): `auto?: boolean`, `kind?: 'tmux' | 'process'`, `pid?: number`, `ports?: number[]`, `cwd?: string`. The `pid`/`ports`/`cwd` fields are only populated when `kind === 'process'`.
- **Pattern:** Existing optional fields in the same interface
- **Verify:** `npx tsc --noEmit`

### 2. Export private functions from scanner.ts (all in one task)
- **File:** `src/dashboard/scanner.ts` (MODIFY)
- **What:** Change 7 functions from module-private to exported: `execQuiet` (line 78), `sessionAlive` (line 92), `listTmuxPanes` (line 101), `getLsofOutput` (line 131), `loadWorkspaceRecords` (line 172), `resolveAndNormalize` (line 209), `autoLinkPane` (line 218). Just add `export` keyword to each -- no logic changes.
- **Pattern:** Already done for `checkTmuxAvailable` (line 87), `getGitInfo` (line 135), `getDescendantPids` (line 109) in the same file
- **Verify:** `npx tsc --noEmit`

### 3. Add process-kind scanning to `scanAllSessions`
- **File:** `src/dashboard/scanner.ts` (MODIFY)
- **What:** In `scanAllSessions` (line 362), when `tmuxAvailable` is false, do NOT return empty -- instead fall through to still scan process-kind session files. For session files with `kind === 'process'`, skip `sessionAlive`/`listTmuxPanes` and instead check PID liveness via `kill -0 <pid>` and re-resolve ports from `getLsofOutput`. Only return early for tmux-kind sessions when tmux is unavailable.
- **Pattern:** Existing `scanSession` function (line 244) handles tmux scanning; add a parallel `scanProcessSession` path
- **Verify:** `npx vitest run src/__tests__/autodiscovery.test.ts`

### 4. Add `auto`/`kind` field support to all servers.ts rewrite paths
- **File:** `src/dashboard/servers.ts` (MODIFY)
- **What:** (a) Extend `buildSessionContent` (line 15) to accept and emit `auto?: boolean` and `kind?: 'tmux' | 'process'` plus process metadata (`pid`, `ports`, `cwd`) in YAML frontmatter. (b) Parse all these fields in `readSessionFile` (line 56) and include them in the returned `SessionFileData`. (c) **Critically:** update `registerSession` (line 39), `updateLastRefreshed` (line 90), and `setOverride` (line 97) to read-then-rewrite preserving `auto`, `kind`, and process metadata fields through the roundtrip. Each of these calls `buildSessionContent` -- pass through the existing fields from `readSessionFile`. (d) Export `buildSessionContent`. (e) Add a new `registerAutoSession(dir, name, kind, processMetadata?)` function.
- **Pattern:** Follow existing `buildSessionContent` YAML emission (lines 15-37) and `readSessionFile` parsing (lines 56-81)
- **Verify:** `npx vitest run src/__tests__/server-tracker.test.ts`

### 5. Create autodiscovery daemon module
- **File:** `src/dashboard/autodiscovery.ts` (CREATE)
- **What:** Implement the daemon with these components:
  - **Singleton lifecycle** (`let timer`, `startAutodiscovery(opts)`, `stopAutodiscovery()`). Options: `serversDir`, `missionsDir`, `intervalMs` (default 45000).
  - **`listAllTmuxSessions()`**: Call `tmux list-sessions -F '#{session_name}'` via imported `execQuiet`, split by newline, return string array.
  - **`discoverTmuxSessions(serversDir, missionsDir)`**: For each tmux session, call `listTmuxPanes` to get panes, call `getGitInfo(cwd)` per unique cwd to get branches, call `autoLinkPane(cwd, branch, workspaceRecords)` for each pane. If any pane matches and no `.md` file exists for that session, call `registerAutoSession` with `kind: 'tmux'`.
  - **`discoverProcesses(serversDir, missionsDir)`**: Call `getLsofOutput()`, parse PIDs of listening processes, resolve each PID's cwd via `lsof -a -d cwd -p <pid>`. Call `getGitInfo(cwd)` per cwd, then `autoLinkPane(cwd, branch, workspaceRecords)` for branch-based matching. Register matches as auto sessions with `kind: 'process'`, storing `pid`, `ports`, `cwd`.
  - **`reconcile(serversDir, missionsDir)`**: Main poll function. (a) Run both discovery functions. (b) For existing files with `auto: true` and `kind === 'tmux'`, check `sessionAlive` via `tmux has-session`; remove if dead. (c) For existing files with `auto: true` and `kind === 'process'`, check PID liveness via `kill -0 <pid>`; remove if dead. (d) Call `clearScanCache()` if any changes were made.
  - No direct broadcast calls -- let chokidar watcher detect `.md` file changes.
- **Pattern:** `session-db.ts` singleton lifecycle (lines 8-74); `execQuiet` shell helper (scanner.ts line 78); `autoLinkPane` matching (scanner.ts line 218)
- **Verify:** `npx vitest run src/__tests__/autodiscovery.test.ts`

### 6. Wire daemon into dashboard server lifecycle
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** (a) Import `startAutodiscovery` and `stopAutodiscovery` from `./autodiscovery.js`. (b) In `start()` (line 206), after the watcher is created (line 207-211), call `startAutodiscovery({ serversDir, missionsDir })`. (c) In `stop()` (line 231), call `stopAutodiscovery()` before closing the watcher (line 232-234).
- **Pattern:** Follow existing `initSessionDb()`/`closeSessionDb()` wiring at lines 81 and 235
- **Verify:** `npx tsc --noEmit`

### 7. Write comprehensive tests
- **File:** `src/__tests__/autodiscovery.test.ts` (CREATE)
- **What:** Cover all seven review gaps:
  - (a) **Non-tmux discovery**: mock `getLsofOutput` and `lsof -a -d cwd` to simulate a process with a cwd matching a workspace record; verify `.md` file created with `kind: 'process'`, `pid`, `ports`, `cwd`.
  - (b) **Branch-only matches**: set up a workspace record with `branch: 'feature-x'` but no `worktreePath`; mock pane with matching branch; verify auto-link works.
  - (c) **`auto`/`kind` preservation**: register an auto session, then call `updateLastRefreshed` and `setOverride`; verify `auto: true` and `kind` survive the roundtrip via `readSessionFile`.
  - (d) **Per-kind reconciliation**: create two auto `.md` files (`kind: 'tmux'` and `kind: 'process'`); mock tmux dead + PID dead; verify both cleaned up by their respective paths.
  - (e) **tmux-unavailable process scanning**: mock tmux unavailable; create a `kind: 'process'` session file; verify `scanAllSessions` still returns it.
  - (f) **Manual sessions untouched**: register a session without `auto: true`; run reconciliation; verify file still exists.
  - (g) **`listAllTmuxSessions` parsing**: test string splitting of tmux output.
  - Use temp directories with `mkdtemp` per `agent-sessions.test.ts` pattern (lines 36-46).
- **Pattern:** `src/__tests__/agent-sessions.test.ts` for temp dir setup + Vitest structure; `src/__tests__/server-tracker.test.ts` for servers.ts I/O tests
- **Verify:** `npx vitest run src/__tests__/autodiscovery.test.ts`

## Dependencies
- No new packages. All shell commands (`tmux`, `lsof`, `pgrep`, `kill`) are already used by scanner.ts.

## Verification
- `npx tsc --noEmit` -- type checks pass
- `npx vitest run` -- all tests pass including new autodiscovery tests
- `npm run build` -- tsup build succeeds
- Manual: start dashboard, observe tmux sessions and non-tmux processes matching assignment workspaces appear in servers view within ~45 seconds without manual registration
