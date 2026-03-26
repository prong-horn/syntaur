# Agent Session Tracking

**Date:** 2026-03-25
**Complexity:** small
**Tech Stack:** TypeScript, Express 5, React 18, react-router-dom 7, Tailwind CSS 3, Commander.js CLI, WebSocket, Chokidar, markdown+YAML frontmatter storage

## Objective

Add agent session logging to Syntaur so that each agent (Claude, Codex, Cursor, etc.) registers its session when grabbing an assignment, and sessions are viewable both per-assignment and globally in the dashboard.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/templates/index-stubs.ts` | MODIFY | Add `Path` column to `renderIndexSessions()` table |
| `src/dashboard/agent-sessions.ts` | CREATE | File I/O for reading/writing `_index-sessions.md` per mission (parse table rows, append row, update status) |
| `src/dashboard/api-agent-sessions.ts` | CREATE | Express router: GET all sessions (aggregate across missions), GET sessions for a mission, POST register session, PATCH update session status |
| `src/dashboard/server.ts` | MODIFY | Mount the agent-sessions router at `/api/agent-sessions` |
| `src/dashboard/watcher.ts` | MODIFY | Emit `'agent-sessions-updated'` WS message when `_index-sessions.md` files change |
| `src/dashboard/types.ts` | MODIFY | Add `AgentSession` and `AgentSessionsResponse` types, add `'agent-sessions-updated'` to `WsMessageType` |
| `src/commands/track-session.ts` | CREATE | CLI command: `syntaur track-session` to register an agent session via the `_index-sessions.md` file directly |
| `src/index.ts` | MODIFY | Register `track-session` CLI command |
| `dashboard/src/types.ts` | MODIFY | Add `AgentSession` and `AgentSessionsResponse` frontend types |
| `dashboard/src/hooks/useMissions.ts` | MODIFY | Add `useAgentSessions()` and `useAssignmentSessions()` hooks, add `'agent-sessions-updated'` WebSocket handling |
| `dashboard/src/pages/AgentSessionsPage.tsx` | CREATE | Global "Agent Sessions" page listing all sessions across all assignments |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | Add "Agent Sessions" section card in the right sidebar (below Servers) showing sessions linked to this assignment |
| `dashboard/src/components/AppShell.tsx` | MODIFY | Add "Agent Sessions" item to `NAV_ITEMS` array |
| `dashboard/src/App.tsx` | MODIFY | Add `/agent-sessions` route |
| `plugin/skills/grab-assignment/SKILL.md` | MODIFY | Add Step 5.5: after creating `syntaur.local.json`, call `syntaur track-session` to register the agent session and write `sessionId` into the context file |

## Tasks

### 1. Add Path column to session index stub
- **File:** `src/templates/index-stubs.ts` (MODIFY)
- **What:** Add `| Path |` column after `| Status |` in `renderIndexSessions()`. The table header becomes: `| Assignment | Agent | Session ID | Started | Status | Path |`
- **Pattern:** Same table-column pattern as `renderIndexAssignments()` in the same file
- **Verify:** `grep 'Path' src/templates/index-stubs.ts`

### 2. Create backend types for agent sessions
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `AgentSession` interface with fields: `missionSlug`, `assignmentSlug`, `agent`, `sessionId`, `started`, `status` (active/completed/abandoned), `path`. Add `AgentSessionsResponse` with `sessions: AgentSession[]` and `generatedAt: string`. Add `'agent-sessions-updated'` to the `WsMessageType` union.
- **Pattern:** Follow `TrackedSession` / `ServersResponse` / `WsMessageType` in the same file
- **Verify:** `npx tsc --noEmit`

### 3. Create agent-sessions file I/O module
- **File:** `src/dashboard/agent-sessions.ts` (CREATE)
- **What:** Functions to: (a) `parseSessionsIndex(missionDir)` - read `_index-sessions.md`, parse the markdown table rows into `AgentSession[]`; (b) `appendSession(missionDir, session)` - append a new table row to the file; (c) `updateSessionStatus(missionDir, sessionId, status)` - find and update a row's Status cell; (d) `listAllSessions(missionsDir)` - scan all mission dirs, aggregate all sessions. Use `extractFrontmatter` from `./parser.js` for reading, string manipulation for table row append/update.
- **Pattern:** Follow `src/dashboard/servers.ts` for file I/O patterns (readFile, writeFileForce, ensureDir, fileExists from `../utils/fs.js`)
- **Verify:** Write a unit test or verify via `npx tsc --noEmit`

### 4. Create agent-sessions API router
- **File:** `src/dashboard/api-agent-sessions.ts` (CREATE)
- **What:** Express router with: `GET /` (all sessions across all missions), `GET /:missionSlug` (sessions for one mission), `POST /` (register a new session, body: `{ missionSlug, assignmentSlug, agent, sessionId, path }`), `PATCH /:sessionId/status` (update status, body: `{ status, missionSlug }`). POST should write to the mission's `_index-sessions.md`.
- **Pattern:** Follow `src/dashboard/api-servers.ts` exactly (Router factory function, try/catch per route, JSON error responses)
- **Verify:** `npx tsc --noEmit`

### 5. Mount the router and wire watcher
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Import `createAgentSessionsRouter` from `./api-agent-sessions.js`, mount at `app.use('/api/agent-sessions', createAgentSessionsRouter(missionsDir))`. The existing missions watcher already watches `_index-sessions.md` changes since it watches the full missions dir tree -- but the WebSocket message type needs to emit `'agent-sessions-updated'` when `_index-sessions.md` files change. Add a check in `watcher.ts` `handleMissionChange`: if the changed file basename is `_index-sessions.md`, emit type `'agent-sessions-updated'` instead of `'mission-updated'`.
- **Pattern:** Follow how `createServersRouter` is imported and mounted on line 168 of server.ts
- **Verify:** `npx tsc --noEmit`

### 6. Create CLI `track-session` command
- **File:** `src/commands/track-session.ts` (CREATE)
- **What:** Commander command that accepts `--mission <slug>`, `--assignment <slug>`, `--agent <name>`, `--session-id <id>`, `--path <path>`. Resolves the mission dir, calls `appendSession()` from the agent-sessions module to write a row to `_index-sessions.md`. If `--session-id` is not provided, generate a UUID-like ID (use `crypto.randomUUID()`).
- **Pattern:** Follow `src/commands/assign.ts` for option handling and error patterns
- **Verify:** `npx tsc --noEmit`

### 7. Register CLI command
- **File:** `src/index.ts` (MODIFY)
- **What:** Import `trackSessionCommand` and register `program.command('track-session')` with the appropriate options and action handler.
- **Pattern:** Follow the existing command registrations (e.g., `assign` on lines 102-119)
- **Verify:** `npx tsx src/index.ts track-session --help`

### 8. Add frontend types
- **File:** `dashboard/src/types.ts` (MODIFY)
- **What:** Add `AgentSession` interface (same shape as backend) and `AgentSessionsResponse` interface. No import needed since frontend types are standalone.
- **Pattern:** Follow `TrackedSession` / `ServersResponse` at end of file
- **Verify:** `npx tsc --noEmit` in dashboard/

### 9. Add React hooks
- **File:** `dashboard/src/hooks/useMissions.ts` (MODIFY)
- **What:** Add `useAgentSessions()` hook calling `/api/agent-sessions` with `'agent-sessions-updated'` WebSocket scope. Add `useAssignmentSessions(missionSlug, assignmentSlug)` hook calling `/api/agent-sessions/:missionSlug?assignment=:assignmentSlug`. Add `'agent-sessions-updated'` handling in the `useFetch` WebSocket callback (alongside `'servers-updated'`). Also need to add `'agent-sessions'` to the websocketScope union type in `useFetch`.
- **Pattern:** Follow `useServers()` on line 388 of the same file
- **Verify:** `npx tsc --noEmit` in dashboard/

### 10. Create Agent Sessions page
- **File:** `dashboard/src/pages/AgentSessionsPage.tsx` (CREATE)
- **What:** Page with PageHeader (eyebrow "Operations", title "Agent Sessions"), a table listing all sessions with columns: Assignment (link to assignment detail), Agent, Session ID, Started (formatted), Status (badge), Path (truncated, with tooltip). Filter by status (active/completed/abandoned). Group or sort by mission.
- **Pattern:** Follow `dashboard/src/pages/ServersPage.tsx` for page structure, PageHeader usage, LoadingState/ErrorState/EmptyState patterns
- **Verify:** Visual check in browser

### 11. Add sessions to AssignmentDetail sidebar
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY)
- **What:** Import `useAgentSessions` (or use a filtered version). After the existing `linkedPanes` Servers SectionCard (line 329-347), add a new SectionCard titled "Agent Sessions" that lists sessions matching this assignment. Show agent name, session ID (truncated), status badge, and started time.
- **Pattern:** Follow the `linkedPanes` Servers SectionCard pattern on lines 329-347 of AssignmentDetail.tsx
- **Verify:** Visual check in browser

### 12. Add nav item and route
- **File:** `dashboard/src/components/AppShell.tsx` (MODIFY)
- **What:** Add `{ to: '/agent-sessions', label: 'Agent Sessions', icon: Activity }` to `NAV_ITEMS` array (import `Activity` from lucide-react). Insert after the Servers item.
- **File:** `dashboard/src/App.tsx` (MODIFY)
- **What:** Import `AgentSessionsPage`, add `<Route path="/agent-sessions" element={<AgentSessionsPage />} />`.
- **Pattern:** Follow Servers nav item and route pattern
- **Verify:** Visual check -- nav item appears, route loads page

### 13. Update grab-assignment skill to register session
- **File:** `plugin/skills/grab-assignment/SKILL.md` (MODIFY)
- **What:** After Step 5 (Create Context File), add Step 5.5: generate a session ID (`crypto.randomUUID()` via bash or use date-based ID), run `syntaur track-session --mission <missionSlug> --assignment <assignmentSlug> --agent claude --session-id <id> --path <cwd>` with `dangerouslyDisableSandbox: true`. Then update the `syntaur.local.json` to include `"sessionId": "<id>"`.
- **Pattern:** Follow the existing `syntaur assign` and `syntaur start` calls in Step 3 of the same skill
- **Verify:** Run `/grab-assignment` on a test mission and check `_index-sessions.md` has a new row

## Dependencies
- No new npm packages required
- `crypto.randomUUID()` is available in Node 19+ (already on Node 20+ based on the codebase)
- Existing `_index-sessions.md` stub files are already created by `create-mission`

## Verification
- `npm run build` -- full TypeScript compilation passes
- `npm test` -- existing tests pass
- Start dashboard (`syntaur dashboard`), verify "Agent Sessions" nav item appears and page loads
- Run `syntaur track-session --mission test-mission --assignment test-assignment --agent claude --path /tmp/test` and verify row appears in `_index-sessions.md`
- Check AssignmentDetail page shows session in sidebar

## Lite Review

**Verdict:** PASS
**Issues Found:** 1 (1 fixed)

- Files table was missing `src/dashboard/watcher.ts` (MODIFY) even though Task 5 explicitly describes modifying `handleMissionChange` in that file to emit `'agent-sessions-updated'` for `_index-sessions.md` changes -- FIXED (added row to Files table)
