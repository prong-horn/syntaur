# Chunk 6: Local Dashboard UI — Discovery Findings

## Metadata
- **Date:** 2026-03-20
- **Complexity:** large
- **Tech Stack:** TypeScript, React, Vite, shadcn/ui, Tailwind CSS (dark mode), Node.js 20+, Express (server), chokidar (file watching), WebSocket (real-time updates)

## Objective
Build a local read-only web dashboard that reads the `~/.syntaur/missions/` directory and displays mission list, mission detail with assignment statuses, and assignment detail with plan/decisions/scratchpad — with real-time updates via file watching.

## User's Request
- React with shadcn/ui components
- Dark mode theme
- Read-only in v1
- Mission list view, mission detail with assignment statuses, assignment detail with plan/decisions/scratchpad
- Real-time updates via file watcher
- The frontend-design plugin should be used during implementation for high design quality

## Codebase Overview

### Existing CLI Package Structure
The project is a TypeScript ESM package built with tsup, using Commander.js for the CLI. The only runtime dependency is `commander`. Testing is done with vitest. The build target is Node 20+.

Key directories:
- `src/commands/` — CLI command handlers (init, create-mission, create-assignment, assign, start, complete, block, unblock, review, fail, install-plugin)
- `src/lifecycle/` — Assignment state machine, frontmatter parser/updater, transition executor
- `src/templates/` — Pure template functions for rendering markdown files
- `src/utils/` — Small focused utility modules (config, fs, paths, slug, timestamp, yaml, uuid)
- `examples/sample-mission/` — Complete realistic example mission with all file types
- `plugin/` — Claude Code plugin with skills and hooks
- `bin/syntaur.js` — CLI entry point

### Data Files the Dashboard Must Read

The dashboard reads from `~/.syntaur/missions/<mission-slug>/` directories. Two categories of files:

**Derived index files** (rebuilt by `syntaur rebuild`):
- `manifest.md` — Root navigation index, links to all other files
- `_index-assignments.md` — Assignment summary table with frontmatter counts (`by_status`)
- `_index-plans.md` — Plan status summary table
- `_index-decisions.md` — Decision record summary table
- `_index-sessions.md` — Active sessions table with `activeSessions` count
- `_status.md` — Mission status rollup with `status`, `progress`, `needsAttention` frontmatter, plus Mermaid dependency graph
- `resources/_index.md` — Resource listing
- `memories/_index.md` — Memory listing

**Source files** (authored by humans/agents):
- `mission.md` — Mission overview with `id`, `slug`, `title`, `archived`, `created`, `updated`, `externalIds`, `tags`
- `assignments/<slug>/assignment.md` — Assignment record with full frontmatter (status, priority, assignee, dependencies, workspace, sessions table, Q&A, progress)
- `assignments/<slug>/plan.md` — Implementation plan with `status` (draft/approved/in_progress/completed), tasks checklist
- `assignments/<slug>/scratchpad.md` — Unstructured working notes
- `assignments/<slug>/handoff.md` — Append-only handoff log with numbered entries
- `assignments/<slug>/decision-record.md` — Append-only decision log with numbered entries
- `resources/<slug>.md` — Reference material (type: resource)
- `memories/<slug>.md` — Learnings (type: memory)

### YAML Frontmatter Format
All files use YAML frontmatter between `---` delimiters. The existing `parseAssignmentFrontmatter()` in `src/lifecycle/frontmatter.ts` handles strings, null, arrays (`[]` and `- item` forms), and one-level nested objects (`workspace`). This parser can be reused or adapted for the dashboard server.

### Key Types Already Defined
- `AssignmentStatus` — `'pending' | 'in_progress' | 'blocked' | 'review' | 'completed' | 'failed'`
- `AssignmentFrontmatter` — Full typed interface for assignment.md frontmatter
- `Workspace` — `{ repository, worktreePath, branch, parentBranch }`
- `ExternalId` — `{ system, id, url }`
- `SyntaurConfig` — Global config with `defaultMissionDir`

### Mission Status Rollup Algorithm
Computed status values: `pending | active | blocked | completed | failed | archived`
Rules (first match wins):
1. `archived: true` in mission.md → archived
2. ALL assignments completed → completed
3. ANY in_progress or review → active
4. ANY failed → failed
5. ANY blocked → blocked
6. ALL pending → pending
7. Otherwise → active

### Build System
- tsup for CLI compilation (ESM, Node 20 target)
- vitest for testing
- TypeScript strict mode
- Single entry point: `src/index.ts`

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `src/index.ts` | CLI entry with 12 commands | Add `dashboard` command registration |
| `package.json` | Package manifest | Add dashboard dependencies (express, chokidar, ws, open) + dev deps (vite, react, @types/react, tailwindcss, shadcn/ui) + new scripts |
| `tsup.config.ts` | CLI build config | May need to add dashboard server entry point |
| `.gitignore` | Git ignores | Add `dashboard/dist/` or `dashboard/.vite/` |
| **New:** `src/commands/dashboard.ts` | — | CLI command handler: starts Express server, serves React SPA + API |
| **New:** `src/dashboard/server.ts` | — | Express server with API routes and WebSocket for file watching |
| **New:** `src/dashboard/api.ts` | — | API route handlers: GET /api/missions, GET /api/missions/:slug, GET /api/missions/:slug/assignments/:slug |
| **New:** `src/dashboard/parser.ts` | — | Shared frontmatter/markdown parser for all file types (extends lifecycle/frontmatter.ts patterns) |
| **New:** `src/dashboard/watcher.ts` | — | Chokidar-based file watcher, emits events over WebSocket |
| **New:** `src/dashboard/types.ts` | — | API response types shared between server and client |
| **New:** `dashboard/` | — | Vite + React app directory |
| **New:** `dashboard/index.html` | — | SPA entry point |
| **New:** `dashboard/vite.config.ts` | — | Vite config with React plugin, Tailwind, proxy to API server |
| **New:** `dashboard/tailwind.config.ts` | — | Tailwind config with dark mode class strategy |
| **New:** `dashboard/postcss.config.js` | — | PostCSS with Tailwind |
| **New:** `dashboard/tsconfig.json` | — | TypeScript config for React |
| **New:** `dashboard/src/main.tsx` | — | React app entry |
| **New:** `dashboard/src/App.tsx` | — | Root component with router |
| **New:** `dashboard/src/components/ui/` | — | shadcn/ui component directory |
| **New:** `dashboard/src/lib/utils.ts` | — | shadcn/ui cn() utility |
| **New:** `dashboard/src/hooks/useWebSocket.ts` | — | WebSocket hook for real-time updates |
| **New:** `dashboard/src/hooks/useMissions.ts` | — | Data fetching hook for missions |
| **New:** `dashboard/src/pages/MissionList.tsx` | — | Mission list view |
| **New:** `dashboard/src/pages/MissionDetail.tsx` | — | Mission detail with assignment table |
| **New:** `dashboard/src/pages/AssignmentDetail.tsx` | — | Assignment detail with plan/decisions/scratchpad tabs |
| **New:** `dashboard/src/components/StatusBadge.tsx` | — | Color-coded status badge component |
| **New:** `dashboard/src/components/DependencyGraph.tsx` | — | Mermaid-based dependency graph visualization |
| **New:** `dashboard/src/components/ProgressBar.tsx` | — | Mission progress indicator |
| **New:** `dashboard/src/components/MarkdownRenderer.tsx` | — | Render markdown content (scratchpad, progress, Q&A) |
| **New:** `dashboard/src/components/Layout.tsx` | — | App shell with sidebar/header, dark mode toggle |
| **New:** `dashboard/src/globals.css` | — | Tailwind base + shadcn/ui CSS variables for dark mode |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Frontmatter parsing | `src/lifecycle/frontmatter.ts` | Regex-based extraction of `---` blocks, field-by-field parsing of YAML subset. Handles strings, null, arrays, nested objects. Dashboard server parser should follow this approach. |
| Pure template/render functions | `src/templates/index-stubs.ts` | Functions take typed params, return strings. Dashboard API handlers should follow: parse files -> transform to typed API response objects. |
| Config reading | `src/utils/config.ts` | `readConfig()` reads `~/.syntaur/config.md` for `defaultMissionDir`. Dashboard server reuses this to find the missions directory. |
| Path utilities | `src/utils/paths.ts` | `syntaurRoot()`, `defaultMissionDir()`, `expandHome()`. Dashboard server reuses these. |
| CLI command registration | `src/index.ts` | `.command()` / `.description()` / `.option()` / `.action()` pattern with try/catch error handling. |
| Assignment file structure | `examples/sample-mission/assignments/implement-jwt-middleware/` | Full example of all 5 files per assignment, with realistic data including sessions, Q&A, progress entries, decisions. |
| Index file frontmatter | `examples/sample-mission/_index-assignments.md` | Frontmatter contains counts (`total`, `by_status`) for quick summary reads without parsing the table. |
| Status file structure | `examples/sample-mission/_status.md` | `needsAttention` frontmatter for quick dashboard alerting (blocked, failed, unanswered questions). |
| Mermaid dependency graph | `examples/sample-mission/_status.md` lines 32-41 | `graph TD` with `classDef` color classes for each status. Dashboard can render this with mermaid.js. |

## CLAUDE.md Rules Found

No repo-level CLAUDE.md exists in `/Users/brennen/syntaur/`.

Global `~/.claude/CLAUDE.md` rules that apply:
- Plans go in `claude-info/plans/` directory (NOT `.claude/plans/`)
- Avoid unnecessary preamble in output
- Shell aliases go in `~/.bash_profile`

The sample mission's `examples/sample-mission/CLAUDE.md` demonstrates the pattern for mission-scoped Claude instructions. Not directly relevant to dashboard implementation but shows what a CLAUDE.md in a mission dir looks like.

## Questions Asked & Answers

No questions asked — proceeding with reasonable defaults:

| Decision | Default Chosen | Rationale |
|----------|---------------|-----------|
| Monorepo structure | Separate `dashboard/` directory with own Vite config, server code in `src/dashboard/` | Keeps React app isolated from CLI build. Server code is part of the main package since it's invoked via `syntaur dashboard` CLI command. |
| Server framework | Express | Lightweight, well-known, minimal overhead for a local-only server. |
| File watching library | chokidar | De facto standard for Node.js file watching, handles platform differences. |
| Real-time transport | WebSocket (ws library) | Simple, low overhead for local use. No need for Socket.io complexity. |
| React router | react-router-dom v7 | Standard React routing. Three routes: `/`, `/missions/:slug`, `/missions/:slug/assignments/:slug`. |
| Development mode | `syntaur dashboard --dev` proxies to Vite dev server | Standard Vite dev workflow with HMR. Production mode serves pre-built static files. |
| Markdown rendering | react-markdown or remark | For rendering scratchpad, progress, Q&A sections. Lightweight. |
| Mermaid rendering | mermaid.js | For dependency graph visualization. Already used in _status.md. |
| Port | Default 4800 with `--port` override | Avoids common port conflicts (3000, 5173, 8080). |
| Dark mode | Tailwind `class` strategy with `dark` class on `<html>` | shadcn/ui default approach. Default to dark, with toggle option. |

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Direct file reading | Package manifest & build system | TypeScript ESM, tsup, vitest, single dep (commander). Node 20+ target. |
| Direct file reading | Protocol spec (chunk 1 plan) | Complete file format definitions for all 15+ file types. YAML frontmatter with `---` delimiters. All timestamps RFC 3339. Paths always absolute in frontmatter. |
| Direct file reading | High-level plan | Dashboard is chunk 6. Read-only in v1. Mission list, mission detail, assignment detail views. Real-time via file watcher. |
| Direct file reading | Chunk 3 (index rebuild) | Defines rebuild pipeline producing 8 derived files. The dashboard reads these derived files for summary data (counts, status rollup, dependency graph). Parser handles full YAML subset. |
| Direct file reading | Chunk 4 (lifecycle engine) | Defines 6 assignment statuses, state machine, frontmatter parser/updater. Types in `src/lifecycle/types.ts` are directly reusable. |
| Direct file reading | Existing source code | 40+ TypeScript files. `src/lifecycle/frontmatter.ts` has reusable parser. `src/utils/` has config, paths, fs utilities. All patterns well-established. |
| Direct file reading | Example mission files | Complete sample mission in `examples/sample-mission/` with all file types populated realistically. Serves as test data and format reference. |

## Architecture Notes

### Server-Side Architecture
The dashboard server (`src/dashboard/server.ts`) is an Express app that:
1. Reads `~/.syntaur/missions/` directory to discover missions
2. Parses markdown files and returns structured JSON via REST API
3. Watches the missions directory with chokidar for changes
4. Broadcasts change events over WebSocket to connected clients
5. Serves the built React SPA as static files (or proxies to Vite in dev mode)

### API Endpoints (Read-Only)
- `GET /api/missions` — List all missions with summary data from `_status.md` and `mission.md`
- `GET /api/missions/:slug` — Mission detail: full status, assignment list, resources, memories
- `GET /api/missions/:slug/assignments/:slug` — Assignment detail: all 5 files parsed and returned
- `GET /api/missions/:slug/graph` — Dependency graph data (parsed from `_status.md` Mermaid block or computed from assignments)
- `WS /ws` — WebSocket for real-time file change notifications

### Client-Side Architecture
React SPA with three pages:
1. **Mission List** — Cards/table showing all missions with status badges, progress bars, needs-attention indicators
2. **Mission Detail** — Header with mission info, assignment table with status/priority/assignee columns, dependency graph, resources/memories sidebar
3. **Assignment Detail** — Tabs for plan, scratchpad, handoff log, decision record. Header with status, assignee, workspace info. Progress timeline. Q&A section.

### Real-Time Update Flow
1. Chokidar watches `~/.syntaur/missions/` recursively
2. On file change, server re-parses affected files
3. Server broadcasts `{ type: 'mission-updated', mission: slug }` or `{ type: 'assignment-updated', mission: slug, assignment: slug }` over WebSocket
4. Client receives event, refetches relevant data via API
5. React re-renders affected components

### Build & Development Modes
- **Production:** `syntaur dashboard` serves pre-built React app from `dashboard/dist/` via Express static middleware
- **Development:** `syntaur dashboard --dev` starts Express API server + proxies to Vite dev server for HMR
- **Build:** `npm run build:dashboard` runs `vite build` in `dashboard/` directory
- The CLI build (tsup) and dashboard build (Vite) are independent

### Reusable Modules from Existing Codebase
- `src/utils/config.ts` — `readConfig()` for finding missions directory
- `src/utils/paths.ts` — `syntaurRoot()`, `defaultMissionDir()`, `expandHome()`
- `src/utils/fs.ts` — `fileExists()`
- `src/lifecycle/types.ts` — `AssignmentStatus`, `AssignmentFrontmatter`, `Workspace`, `ExternalId`
- `src/lifecycle/frontmatter.ts` — `parseAssignmentFrontmatter()` (can be extended for other file types)
