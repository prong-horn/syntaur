# Quick Todos Implementation

**Date:** 2026-04-07
**Complexity:** small → medium (revised after Codex review)
**Tech Stack:** TypeScript, Commander (CLI), Express 5 (API), React 18 + Tailwind + Radix (Dashboard), chokidar (watcher), vitest (tests)

## Objective
Add a lightweight workspace-scoped checklist system (Quick Todos) that lives outside the mission/assignment hierarchy. Includes file parser/writer, CLI commands, API endpoints, file watcher, and dashboard pages per the design in `claude-info/plans/2026-04-07-quick-todos-design.md`.

## Revision Notes (post-Codex review)
- Added missing files: `src/commands/dashboard.ts`, `dashboard/src/hooks/useWebSocket.ts`
- Fixed `DashboardServerOptions` location (it's in `server.ts`, not `types.ts`)
- Added aggregate `GET /api/todos` endpoint for global page + overview card
- Added log-fetching to the data hook
- Defined edge cases: missing files return empty checklist, workspace validation, ID collision retry, archive no-op
- Fixed task ordering: server wiring and data contracts before frontend pages

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/todos/types.ts` | CREATE | Todo item, log entry, archive interval types |
| `src/todos/parser.ts` | CREATE | Checklist + log file parser/writer |
| `src/todos/index.ts` | CREATE | Re-exports |
| `src/commands/todo.ts` | CREATE | Commander subcommand group for `syntaur todo` |
| `src/dashboard/api-todos.ts` | CREATE | Express Router for `/api/todos` endpoints |
| `dashboard/src/pages/TodosPage.tsx` | CREATE | Global todos page |
| `dashboard/src/pages/WorkspaceTodosPage.tsx` | CREATE | Workspace-scoped todos page |
| `dashboard/src/hooks/useTodos.ts` | CREATE | React hooks for todo data |
| `src/__tests__/todos-parser.test.ts` | CREATE | Parser/writer unit tests |
| `src/utils/paths.ts` | MODIFY | Add `todosDir()` helper |
| `src/index.ts` | MODIFY | Register `syntaur todo` subcommand group |
| `src/commands/dashboard.ts` | MODIFY | Pass `todosDir` to `createDashboardServer` |
| `src/dashboard/server.ts` | MODIFY | Add `todosDir` to options, mount todos router |
| `src/dashboard/watcher.ts` | MODIFY | Add todos directory watcher |
| `src/dashboard/types.ts` | MODIFY | Add `todos-updated` to WsMessageType |
| `dashboard/src/hooks/useWebSocket.ts` | MODIFY | Add `todos-updated` to WsMessage type union |
| `dashboard/src/App.tsx` | MODIFY | Add routes for `/todos` and `/w/:workspace/todos` |
| `dashboard/src/components/AppShell.tsx` | MODIFY | Add Todos to sidebar nav |
| `dashboard/src/lib/routes.ts` | MODIFY | Add `/todos` to sidebar sections, section detection, breadcrumbs |
| `dashboard/src/pages/Overview.tsx` | MODIFY | Add Quick Todos stat card |
| `dashboard/src/types.ts` | MODIFY | Add Todo types for dashboard |

## Tasks

### 1. Types
- **File:** `src/todos/types.ts` (CREATE)
- **What:** Define `TodoStatus` (`open | in_progress | completed | blocked`), `TodoItem` (id, description, status, tags, session), `TodoChecklist` (workspace, archiveInterval, items), `LogEntry` (timestamp, itemIds, session, branch, summary, blockers, status), `TodoLog` (workspace, entries), `ArchiveInterval` (`daily | weekly | monthly | never`)

### 2. Parser/writer
- **File:** `src/todos/parser.ts` (CREATE)
- **What:** Parse checklist markdown into `TodoChecklist` using `extractFrontmatter`/`getField` from `src/dashboard/parser.ts` for frontmatter. Custom regex for status markers (`- [ ]`, `- [>:SESSION]`, `- [x]`, `- [!]`), tags (`#tag`), and short IDs (`[t:XXXX]`). Writer serializes back to markdown. Parse log markdown into `TodoLog` (heading-delimited entries). Writer appends new log entries. Generate short IDs via `crypto.randomBytes(2).toString('hex')` with collision retry (read existing IDs, regenerate if collision).
- **Edge cases:** Missing file returns empty checklist with defaults. Invalid lines are preserved as-is during round-trip.

### 3. Re-export barrel
- **File:** `src/todos/index.ts` (CREATE)

### 4. Path helper
- **File:** `src/utils/paths.ts` (MODIFY)
- **What:** Add `todosDir()` returning `resolve(syntaurRoot(), 'todos')` after `playbooksDir()` on line 25

### 5. CLI commands
- **File:** `src/commands/todo.ts` (CREATE)
- **What:** Export a Commander `Command` named `todo` with subcommands. Workspace inferred from `--workspace <slug>` or `--global` flag (defaults to `_global` if neither provided and CWD doesn't map to a workspace).
- **Subcommands:**
  - `add <description> [--tags tag1,tag2] [--workspace slug | --global]` — append item with generated ID
  - `list [--tag tag] [--status open|blocked|done|active] [--workspace slug | --global]` — print items
  - `start <id>` — mark `[>:SESSION_ID]`, session ID from env or generated
  - `complete <id> [--summary "..."] [--branch name]` — mark `[x]`, write log entry
  - `block <id> --reason "..."` — mark `[!]`, write log entry
  - `unblock <id>` — return to `[ ]`
  - `delete <id>` — remove from checklist, no log
  - `promote <id> --mission <slug>` — scaffold assignment, mark `[x]`, log with promotion note
  - `archive [--workspace slug | --global]` — move completed items + logs to archive
  - `log [id]` — show log entries
  - `edit <id> <description>` — update description text
  - `tag <id> --add tag1 --remove tag2` — modify tags
- **Pattern:** Register as `program.addCommand(todoCommand)` in `src/index.ts`. Error handling per command action with try/catch + `console.error` + `process.exit(1)`.

### 6. Register CLI command
- **File:** `src/index.ts` (MODIFY)
- **What:** Import `todoCommand` from `./commands/todo.js`. Add `program.addCommand(todoCommand)` before the default-to-dashboard block (before line 378).

### 7. Backend types: WsMessageType
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `'todos-updated'` to `WsMessageType` union on line 305-311.

### 8. API router
- **File:** `src/dashboard/api-todos.ts` (CREATE)
- **What:** `createTodosRouter(todosDir: string): Router` factory following `api-playbooks.ts` pattern.
- **Endpoints:**
  - `GET /` — aggregate: list all workspace checklists + `_global`. Returns `{ workspaces: [{workspace, items, counts}...] }`.
  - `GET /:workspace` — list items for one workspace. If file doesn't exist, return `{ workspace, archiveInterval: 'weekly', items: [], counts: {open:0, in_progress:0, completed:0, blocked:0, total:0} }`.
  - `POST /:workspace` — add item. Body: `{description, tags?}`. Validates workspace name with `/^[a-z0-9_][a-z0-9-]*$/` (allowing `_global`). Returns created item.
  - `GET /:workspace/:id` — single item + its log entries
  - `PATCH /:workspace/:id` — update description or tags. Body: `{description?, tags?}`
  - `DELETE /:workspace/:id` — remove item, 404 if not found
  - `POST /:workspace/:id/start` — mark in-progress. Body: `{session}`
  - `POST /:workspace/:id/complete` — mark done. Body: `{summary, session?, branch?}`. Writes log entry.
  - `POST /:workspace/:id/block` — mark blocked. Body: `{reason}`. Writes log entry.
  - `POST /:workspace/:id/unblock` — return to open
  - `GET /:workspace/log` — full log for workspace
  - `GET /:workspace/log/:id` — log entries for specific item
  - `POST /:workspace/archive` — trigger archive
- **Edge cases:** 400 for invalid workspace names. 404 for unknown item IDs. Broadcast `todos-updated` WsMessage after mutations.

### 9. Server wiring
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Add `todosDir` to `DashboardServerOptions` interface (line 40-46). Import `createTodosRouter`. Destructure `todosDir` from options. Mount with `app.use('/api/todos', createTodosRouter(todosDir))` after playbooks mount (line 300). Pass `todosDir` to `createWatcher` (line 326-331). Pass broadcast to todos router for WS notifications.
- **File:** `src/commands/dashboard.ts` (MODIFY)
- **What:** Import `todosDir as getTodosDir` from `../utils/paths.js` (line 6). Add `todosDir: getTodosDir()` to the `createDashboardServer` options object (line 26-32).

### 10. File watcher
- **File:** `src/dashboard/watcher.ts` (MODIFY)
- **What:** Add `todosDir?: string` to `WatcherOptions` (line 5-10). Add todos watcher block following playbooks pattern (lines 103-135): depth 1, debounced, emits `{ type: 'todos-updated', timestamp }`. Add to close() cleanup.

### 11. Frontend types
- **File:** `dashboard/src/types.ts` (MODIFY)
- **What:** Add `TodoItem` (id, description, status, tags, session), `TodoListResponse` (workspace, archiveInterval, items, counts), `TodoLogEntry` (timestamp, itemIds, items, session, branch, summary, blockers, status), `TodoAggregateResponse` (workspaces array of TodoListResponse).

### 12. Frontend WebSocket type
- **File:** `dashboard/src/hooks/useWebSocket.ts` (MODIFY)
- **What:** Add `'todos-updated'` to the `WsMessage.type` union on line 4.

### 13. Todos data hook
- **File:** `dashboard/src/hooks/useTodos.ts` (CREATE)
- **What:**
  - `useTodos(workspace)` — fetches `GET /api/todos/:workspace`, auto-refreshes on `todos-updated` WS message. Returns `{data, loading, error, refetch}`.
  - `useAllTodos()` — fetches `GET /api/todos` (aggregate endpoint), auto-refreshes on `todos-updated`.
  - `useTodoLog(workspace, id?)` — fetches log data for expandable panels.
  - Mutation helpers: `addTodo`, `completeTodo`, `blockTodo`, `startTodo`, `unblockTodo`, `deleteTodo` — POST/PATCH/DELETE then refetch.
- **Pattern:** Follow `useMissions.ts` (useState + useEffect + fetch, useWebSocket for live updates).

### 14. Dashboard pages
- **File:** `dashboard/src/pages/TodosPage.tsx` (CREATE)
- **What:** Global todos page using `useAllTodos()`. Workspace filter tabs, tag filter chips, status filter. Summary counts per workspace via `StatCard`. Action buttons for complete/block/delete. Add-todo form.
- **File:** `dashboard/src/pages/WorkspaceTodosPage.tsx` (CREATE)
- **What:** Single-workspace view using `useTodos(workspace)`. Checklist with inline status toggling. Tag filter chips. Expandable log panel per item using `useTodoLog`. Promote button links to assignment creation.
- **Pattern:** Use `LoadingState`/`ErrorState`/`EmptyState`, `SectionCard`, `StatCard`.

### 15. Routing and navigation
- **File:** `dashboard/src/App.tsx` (MODIFY)
- **What:** Import `TodosPage` and `WorkspaceTodosPage`. Add `<Route path="/todos" element={<TodosPage />} />` in global routes (after playbooks, ~line 41). Add `<Route path="/w/:workspace/todos" element={<WorkspaceTodosPage />} />` in workspace routes (after agent-sessions, ~line 58).
- **File:** `dashboard/src/lib/routes.ts` (MODIFY)
- **What:** Add `'/todos'` to `SIDEBAR_SECTIONS` array (line 14). Add `if (normalized.startsWith('/todos'))` block returning `'/todos'` in `getSidebarSection` (after playbooks check, ~line 69). Add `parts[0] === 'todos'` handling in `buildShellMeta` (after playbooks, ~line 155): title 'Todos', breadcrumbs `[{label: 'Todos', path: '/todos'}]`.
- **File:** `dashboard/src/components/AppShell.tsx` (MODIFY)
- **What:** Import `CheckSquare` from lucide-react (line 4). Add `{ to: '/todos', label: 'Todos', icon: CheckSquare }` to `GLOBAL_NAV_ITEMS` after Attention (line 27). Add `{ suffix: '/todos', label: 'Todos', icon: CheckSquare }` to `WORKSPACE_SCOPED_LABELS` (line 34).

### 16. Overview integration
- **File:** `dashboard/src/pages/Overview.tsx` (MODIFY)
- **What:** Import `useAllTodos` from `../hooks/useTodos`. Add a `StatCard` for open todos in the stats grid: `<StatCard label="Open Todos" value={todoCount} icon={CheckSquare} to="/todos" />`. Compute `todoCount` from aggregate data (sum of open + in_progress across all workspaces).

### 17. Tests
- **File:** `src/__tests__/todos-parser.test.ts` (CREATE)
- **What:** Unit tests for:
  - Parsing all 4 status markers (open, in-progress with session, completed, blocked)
  - Parsing tags and short IDs
  - Parsing frontmatter (workspace, archiveInterval)
  - Round-trip: parse then serialize preserves content
  - Missing file returns empty checklist
  - Log entry parsing (heading, fields)
  - Log entry appending
  - Short ID generation and collision handling
  - Archive file naming for each interval
- **Verify:** `npx vitest run src/__tests__/todos-parser.test.ts`

## Dependencies
- No new npm packages (uses existing crypto, chokidar, express, commander, lucide-react)

## Verification
- `npx vitest run` — all tests pass
- `npm run build` — TypeScript compiles cleanly
- `npm run build:dashboard` — dashboard builds
- `syntaur todo add "test item" --global` — creates `~/.syntaur/todos/_global.md`
- `syntaur todo list --global` — lists the item
- `syntaur dashboard` — navigate to `/todos`, verify page renders
