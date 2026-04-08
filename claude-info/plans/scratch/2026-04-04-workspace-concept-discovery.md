# Workspace Concept -- Discovery Findings

## Metadata
- **Date:** 2026-04-04
- **Complexity:** large
- **Tech Stack:** TypeScript / Node.js (Express + Commander CLI) backend, React 18 + Vite + Tailwind + react-router-dom dashboard, markdown-as-database protocol with YAML frontmatter

## Objective
Introduce a "Workspace" grouping concept to the Syntaur protocol and dashboard. A `workspace` string field on `mission.md` frontmatter allows missions (and their assignments) to be organized by codebase/context. The dashboard sidebar is redesigned from a flat nav to workspace-scoped sections.

## User's Request
Add a lightweight `workspace` field to mission frontmatter that groups missions by codebase/context. Redesign the dashboard sidebar into three zones: global pages (Overview, Attention, Playbooks), workspace-scoped pages (Missions, Assignments, Servers, Agent Sessions per workspace), and utility pages (Help, Settings). No new directory hierarchy -- just a string field. Missions without a workspace are grouped as "Ungrouped."

## Codebase Overview

### Protocol Layer
- **Spec:** `docs/protocol/spec.md` -- defines directory structure, file ownership, lifecycle, naming conventions
- **File Formats:** `docs/protocol/file-formats.md` -- YAML frontmatter schemas for all file types
- **Mission frontmatter** currently has: `id`, `slug`, `title`, `archived`, `archivedAt`, `archivedReason`, `created`, `updated`, `externalIds`, `tags`. No `workspace` field exists.
- **Assignment frontmatter** has a `workspace` object for code workspace info (repository, worktreePath, branch, parentBranch). This is a different concept -- must be careful with naming collision.

### Server/API Layer (`src/dashboard/`)
- **`api.ts`** -- Core data functions: `listMissions()`, `getOverview()`, `getAttention()`, `listAssignmentsBoard()`, `getMissionDetail()`, `getAssignmentDetail()`. All iterate `~/.syntaur/missions/` directories and parse frontmatter.
- **`parser.ts`** -- `parseMission()` extracts frontmatter fields. Does NOT currently extract a `workspace` field from missions.
- **`server.ts`** -- Express server with routes: `/api/overview`, `/api/missions`, `/api/assignments`, `/api/attention`, `/api/help`, `/api/config/statuses`, plus sub-routers for write, servers, agent-sessions, playbooks.
- **`api-write.ts`** -- POST/PATCH routes for creating/editing missions and assignments. Uses templates from `src/templates/`.
- **`types.ts`** -- Server-side TypeScript interfaces. `MissionSummary` and `MissionDetail` have no workspace field.
- **`scanner.ts`** -- Server tracker. Uses `WorkspaceRecord` (assignment code workspace) for auto-linking panes to assignments.
- **`watcher.ts`** -- Chokidar file watcher broadcasting WebSocket messages on file changes.

### Dashboard Layer (`dashboard/src/`)
- **`App.tsx`** -- React Router routes. Flat structure: `/`, `/missions`, `/assignments`, `/servers`, `/agent-sessions`, `/playbooks`, `/attention`, `/help`, `/settings`, plus nested routes under `/missions/:slug/...`.
- **`components/AppShell.tsx`** -- Main layout with sidebar. `NAV_ITEMS` is a flat array of 9 items rendered by `SidebarNav`. This is the primary file for sidebar redesign.
- **`components/SidebarNav.tsx`** -- Simple component rendering `Link` items with active state detection via `isSidebarItemActive()`.
- **`lib/routes.ts`** -- `SIDEBAR_SECTIONS` array, `getSidebarSection()`, `buildShellMeta()` for breadcrumbs. Routing logic hardcodes current flat structure.
- **`hooks/useMissions.ts`** -- Data hooks: `useMissions()`, `useOverview()`, `useAssignmentsBoard()`, `useAttention()`, etc. All fetch from `/api/` endpoints.
- **`pages/MissionList.tsx`** -- Lists all missions with filter/sort/search. Has cards, table, and kanban views.
- **`pages/AssignmentsPage.tsx`** -- Lists all assignments across all missions with filter/sort. Has kanban, table, and list views. Already has a "mission" filter dropdown.
- **`pages/AgentSessionsPage.tsx`** -- Lists all agent sessions. No workspace grouping.
- **`pages/ServersPage.tsx`** -- Lists tracked server sessions.
- **`pages/Overview.tsx`** -- Global overview with stats, attention items, recent missions, activity.
- **`types.ts`** -- Client-side types (duplicated from server types).

### CLI Layer (`src/commands/`)
- **`create-mission.ts`** -- `createMissionCommand()` generates mission scaffold. Uses `renderMission()` template. No workspace parameter.
- **`src/templates/mission.ts`** -- `renderMission()` template. Outputs frontmatter with fixed fields. Does not include `workspace`.

### Plugin Layer (`plugin/`)
- **`skills/create-mission/SKILL.md`** -- Skill for creating missions via Claude Code. References CLI args but no workspace.
- **`skills/grab-assignment/SKILL.md`** -- Skill for claiming assignments. Reads mission files. Would benefit from workspace awareness.
- **`skills/complete-assignment/SKILL.md`** -- Handoff skill.
- **`skills/syntaur-protocol/SKILL.md`** -- Protocol reference skill.

## Files That Will Need Changes

| File | Current Purpose | Needed Change |
|------|----------------|---------------|
| `docs/protocol/spec.md` | Protocol specification | Add workspace concept to Section 2 (design principles) and Section 3 (directory structure) |
| `docs/protocol/file-formats.md` | File format schemas | Add `workspace` field to mission.md frontmatter schema |
| `src/dashboard/parser.ts` | Frontmatter parsing | Add `workspace` field to `ParsedMission` interface and `parseMission()` |
| `src/dashboard/types.ts` | Server-side types | Add `workspace` field to `MissionSummary` and `MissionDetail` |
| `src/dashboard/api.ts` | API data functions | Include `workspace` in mission summaries/details; add workspace-filtered endpoints or query params |
| `src/dashboard/server.ts` | Express routes | Add workspace query parameter support to existing endpoints (e.g., `GET /api/missions?workspace=syntaur`) |
| `src/templates/mission.ts` | Mission template | Add optional `workspace` field to `MissionParams` and rendered output |
| `src/commands/create-mission.ts` | CLI create-mission | Add `--workspace` option |
| `src/index.ts` | CLI entry point | Wire `--workspace` option to create-mission command |
| `dashboard/src/types.ts` | Client-side types | Add workspace field to types |
| `dashboard/src/App.tsx` | Router config | Add workspace-scoped routes: `/w/:workspace/missions`, `/w/:workspace/assignments`, etc. |
| `dashboard/src/components/AppShell.tsx` | Main layout + sidebar | Complete sidebar redesign: three zones, workspace sections with collapsible nav |
| `dashboard/src/components/SidebarNav.tsx` | Flat nav list | Extend to support grouped/sectioned nav items |
| `dashboard/src/lib/routes.ts` | Route helpers | Add workspace-aware `SIDEBAR_SECTIONS`, `getSidebarSection()`, `buildShellMeta()` |
| `dashboard/src/hooks/useMissions.ts` | Data hooks | Add workspace-scoped versions of hooks (e.g., `useMissions(workspace)`) or add workspace param to existing hooks |
| `dashboard/src/pages/MissionList.tsx` | Mission list page | Accept workspace context, filter missions by workspace |
| `dashboard/src/pages/AssignmentsPage.tsx` | Assignment board | Accept workspace context, filter assignments by workspace |
| `dashboard/src/pages/AgentSessionsPage.tsx` | Agent sessions | Accept workspace context, filter by workspace |
| `dashboard/src/pages/ServersPage.tsx` | Server tracking | Accept workspace context, filter by workspace (via assignment workspace mapping) |
| `dashboard/src/pages/Overview.tsx` | Global overview | Stays global but may show workspace breakdown |
| `dashboard/src/pages/Attention.tsx` | Attention queue | Stays global |
| `dashboard/src/pages/CreateMission.tsx` | Create mission form | Pre-populate workspace field when creating from within a workspace context |
| `plugin/skills/create-mission/SKILL.md` | Create mission skill | Add workspace option guidance |
| `plugin/skills/grab-assignment/SKILL.md` | Grab assignment skill | Add workspace awareness to mission discovery |
| `examples/sample-mission/mission.md` | Example mission | Add `workspace` field to example |

## Patterns Discovered

| Pattern | Reference File | Description |
|---------|---------------|-------------|
| Frontmatter parsing | `src/dashboard/parser.ts` | Uses regex-based extraction: `getField(fm, 'key')` for scalars, `getNestedField(fm, 'parent', 'child')` for nested. New `workspace` field on missions is a top-level scalar, so use `getField()`. |
| Type mirroring | `src/dashboard/types.ts` + `dashboard/src/types.ts` + `dashboard/src/hooks/useMissions.ts` | Types are defined in 3 places: server types, client types, and hook interfaces. All must stay synchronized. |
| API data flow | `api.ts` -> `server.ts` -> hooks -> pages | Data flows: parser reads files -> API functions build response objects -> Express routes serve JSON -> React hooks fetch -> pages render. |
| Sidebar structure | `components/AppShell.tsx` | `NAV_ITEMS` is a flat `SidebarNavItem[]` array with `{to, label, icon}`. Passed to `SidebarNav` component. Must be redesigned to support grouped structure. |
| Route detection | `lib/routes.ts` | `getSidebarSection()` maps pathname prefixes to sidebar sections. `buildShellMeta()` generates title and breadcrumbs from URL segments. Both need workspace-aware versions. |
| Template rendering | `src/templates/mission.ts` | Templates take a params object and return a string with YAML frontmatter. `renderMission({id, slug, title, timestamp})` -- add optional `workspace` param. |
| CLI options | `src/commands/create-mission.ts` | Commander options pattern: `.option('--slug <slug>')`. Add `.option('--workspace <workspace>')`. |
| Filter-based scoping | `dashboard/src/pages/AssignmentsPage.tsx` | Existing pages filter data client-side using `useMemo` + filter functions. Mission filter already exists as a dropdown. Workspace scoping can follow this pattern. |

## CLAUDE.md Rules Found
- No CLAUDE.md files found in the repository root or dashboard directory. Project-level CLAUDE.md is not present.
- The sample mission at `examples/sample-mission/claude.md` contains Claude Code-specific instructions (typecheck, test patterns, commit conventions). These are mission-level, not project-level.
- Global user rules from `~/.claude/CLAUDE.md`: plans go in `claude-info/plans/`, shell aliases in `~/.bash_profile`, env vars managed via GCP Secret Manager.
- Memory notes: workspace fields should be set before implementation to avoid boundary hook blocks; assignment records should be updated in real-time.

## Questions Asked & Answers

| Question | Answer |
|----------|--------|
| Naming collision with assignment `workspace` object? | The user specified "Workspace" for the organizational concept. The assignment `workspace` object is for code workspace info (repo, branch, worktree). These are different concepts. The mission-level field will be `workspace: "syntaur"` (a string), while assignment-level is `workspace: {repository: ..., branch: ...}` (an object). The YAML types differ, but the protocol docs should clarify the distinction explicitly. |
| No clarifying questions needed | The user's request is exceptionally well-defined with specific sidebar layout, terminology decisions, scoping rules, and migration path already decided. |

## Exploration Log

| Explorer | Focus Area | Key Findings |
|----------|-----------|--------------|
| Explorer 1 | API routes, server.ts, dashboard pages | Express server has flat route structure. All API endpoints serve data from `listMissionRecords()` which scans `~/.syntaur/missions/` directories. No workspace filtering exists. Dashboard pages all use flat routing under `/missions`, `/assignments`, etc. The API needs workspace query params, and the dashboard needs workspace-prefixed routes. |
| Explorer 2 | Types, parser, data models | `parseMission()` returns `ParsedMission` with no workspace field. Types are mirrored in 3 locations (server types, client types, hook interfaces). `MissionSummary` and `MissionDetail` both need a `workspace` string field. The parser's `getField()` function handles top-level scalars, which is exactly what the workspace field needs. |
| Explorer 3 | Sidebar, routing, plugins | Sidebar is a flat `NAV_ITEMS` array in `AppShell.tsx`. Route detection in `lib/routes.ts` maps pathnames to sidebar sections. Plugin skills reference mission/assignment slugs but not workspaces. The sidebar redesign is the largest visual change -- requires a new component structure for grouped/collapsible workspace sections. |

## Reflection

### What I understand:
1. The workspace concept is purely a string field on `mission.md` frontmatter -- no directory changes.
2. The dashboard sidebar needs a complete redesign from flat nav to three-zone grouped nav.
3. Routes change from `/missions` to `/w/:workspace/missions` for workspace-scoped pages.
4. Global pages (Overview, Attention, Playbooks) remain unscoped.
5. The API needs to support workspace filtering, either via query params or new endpoints.
6. All existing pages that show missions/assignments need to accept workspace context.
7. The naming collision between mission `workspace` (string, organizational) and assignment `workspace` (object, code context) must be documented clearly.

### What will need changes and why:
- **Protocol docs** -- Define the new field formally so it's part of the spec.
- **Parser** -- Must extract the new field from mission frontmatter.
- **API** -- Must expose workspace data and support filtering by workspace.
- **Templates** -- Must include workspace in generated mission files.
- **CLI** -- Must accept `--workspace` when creating missions.
- **Dashboard routing** -- Must add workspace-prefixed routes.
- **Dashboard sidebar** -- Must be redesigned for grouped workspace sections.
- **Dashboard pages** -- Must accept and use workspace context for filtering.
- **Plugins** -- Must be updated for workspace awareness.

### Patterns to follow:
- Use `getField(fm, 'workspace')` in parser (existing pattern for scalar fields).
- Mirror types across server/client/hooks (existing pattern).
- Use query params for API filtering (simpler than new endpoints).
- Use react-router `useParams()` for workspace context in pages.

### Remaining concerns:
1. **Naming collision**: The term "workspace" is used for two different things. Assignment frontmatter has `workspace: {repository, branch, ...}` for code context. Mission frontmatter will have `workspace: "syntaur"` for organizational grouping. The YAML types differ (object vs string), so there's no parse ambiguity, but the semantic overlap needs clear documentation.
2. **Migration**: Existing missions without a `workspace` field need a default. "Ungrouped" was suggested. The parser should return `null` for missions without the field, and the dashboard should display `null` as "Ungrouped."
3. **URL structure**: `/w/:workspace/missions` is one option. Need to decide if "Ungrouped" has a special URL slug (e.g., `/w/_ungrouped/missions` or `/w/~/missions`).
4. **Workspace discovery**: The API needs to return a list of known workspaces (derived from scanning all mission frontmatter). This is needed for the sidebar to know which workspace sections to render.
5. **Server/Agent Session workspace mapping**: Servers and agent sessions are linked to missions/assignments. Their workspace scoping is derived from the parent mission's workspace field, not from a direct workspace field on the session/server.

## Complexity Assessment: LARGE

This change touches 24+ files across 5 layers (protocol, server API, templates/CLI, dashboard, plugins). It requires:
- Protocol spec updates (2 docs)
- Server-side parser, type, and API changes (5+ files)
- Template and CLI changes (3+ files)
- Dashboard routing overhaul (App.tsx, routes.ts)
- Dashboard sidebar complete redesign (AppShell.tsx, SidebarNav.tsx)
- Dashboard page updates for workspace context (6+ pages)
- Plugin skill updates (3+ files)
- Example/documentation updates

The sidebar redesign alone is a significant UI architecture change. Combined with the routing overhaul and API changes, this is clearly a large-scope feature.
