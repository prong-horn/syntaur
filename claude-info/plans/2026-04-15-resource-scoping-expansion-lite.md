# Resource Scoping Expansion

**Date:** 2026-04-15
**Complexity:** small
**Tech Stack:** TypeScript, Node.js (ESM), Express 5, better-sqlite3, React, Vite, Vitest

## Objective
Expand resource scoping from mission-only to three levels: global (`~/.syntaur/resources/`), workspace (`~/.syntaur/workspaces/<name>/resources/`), and mission (current behavior). Mission detail API merges all three scopes with a `scope` indicator on each resource. Protocol docs, platform skill files, and help text are updated to reflect the new scoping.

## Design Decisions

- **Scope derivation:** Scope is inferred from filesystem location, not stored in resource frontmatter. This avoids changing the documented resource schema in `docs/protocol/file-formats.md:910`. The `scope` field exists only on `ParsedResource` (set by the parser caller) and `ResourceSummary` (returned by APIs).
- **Composite key:** When resources from multiple scopes are merged, React keys and API identity use `${scope}:${slug}` to avoid collisions (e.g., a global `test.md` and mission `test.md` coexist).
- **Merge order:** Global resources appear first, then workspace, then mission. Sorted by `updated` within each scope group.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/utils/paths.ts` | MODIFY | Add `globalResourcesDir()` and `workspaceResourcesDir(name)` helpers |
| `src/dashboard/parser.ts` | MODIFY | Add `scope` field to `ParsedResource` interface |
| `src/dashboard/types.ts` | MODIFY | Add `scope`, `workspace?`, `missionSlug?` to `ResourceSummary`; add `'resources-updated'` to `WsMessageType` |
| `src/dashboard/api.ts` | MODIFY | Add `listGlobalResources()`, `listWorkspaceResources()`; update `listResources()` to accept scope; update `getMissionDetail()` to merge all scopes |
| `src/dashboard/server.ts` | MODIFY | Add `GET /api/resources` and `GET /api/workspaces/:name/resources` routes; pass `globalResourcesDir` to watcher |
| `src/dashboard/api-write.ts` | MODIFY | Create `resources/` dir inside workspace dirs during workspace scaffolding |
| `src/dashboard/watcher.ts` | MODIFY | Add `globalResourcesDir` and `workspaceResourcesDirs` watcher options |
| `src/commands/init.ts` | MODIFY | Create `~/.syntaur/resources/` during init |
| `src/templates/index-stubs.ts` | MODIFY | Make `renderResourcesIndex()` accept optional `scope` param |
| `src/templates/cursor-rules.ts` | MODIFY | Expand write boundaries to include global and workspace resource paths |
| `src/templates/codex-agents.ts` | MODIFY | Same as cursor-rules |
| `dashboard/src/hooks/useWebSocket.ts` | MODIFY | Add `'resources-updated'` to frontend `WsMessage.type` union |
| `dashboard/src/hooks/useMissions.ts` | MODIFY | Add `scope` to frontend `ResourceSummary`; add refetch on `resources-updated` event |
| `dashboard/src/pages/MissionDetail.tsx` | MODIFY | Show scope badge; use composite key; update empty-state copy |
| `docs/protocol/spec.md` | MODIFY | Document global and workspace resource locations in directory tree and rules |
| `docs/protocol/file-formats.md` | MODIFY | Add note that resources can exist at global/workspace/mission level |
| `platforms/claude-code/skills/syntaur-protocol/SKILL.md` | MODIFY | Update resource paths to include all three scopes |
| `platforms/codex/skills/syntaur-protocol/SKILL.md` | MODIFY | Update resource paths to include all three scopes |
| `src/dashboard/help.ts` | MODIFY | Update help text to mention global/workspace resources |

## Tasks

### 1. Add path helpers
- **File:** `src/utils/paths.ts` (lines 1-29)
- **What:** Add two functions after `todosDir()` at line 28:
  - `globalResourcesDir()` → `resolve(syntaurRoot(), 'resources')`
  - `workspaceResourcesDir(name: string)` → `resolve(syntaurRoot(), 'workspaces', name, 'resources')`
- **Pattern:** Follow `serversDir()` / `playbooksDir()` / `todosDir()` pattern exactly.
- **Verify:** `npx vitest run --reporter=verbose 2>&1 | head -50` (no compile errors)

### 2. Create global resources dir on init
- **File:** `src/commands/init.ts` (lines 20-22)
- **What:** Add `const resourcesDir = resolve(root, 'resources');` and `await ensureDir(resourcesDir);` after the `await ensureDir(playbooksDir)` call at line 22. Add corresponding `console.log` lines in both the force and non-force branches.
- **Verify:** `npx vitest run src/__tests__/commands.test.ts`

### 3. Update index stub template to accept scope
- **File:** `src/templates/index-stubs.ts` (lines 94-106)
- **What:** Add optional `scope?: 'global' | 'workspace' | 'mission'` and optional `workspace?: string` to `IndexStubParams`. In `renderResourcesIndex()`, replace the hardcoded `mission: ${params.slug}` frontmatter line:
  - If `scope === 'global'`: emit `scope: global`
  - If `scope === 'workspace'`: emit `scope: workspace` and `workspace: ${params.workspace}`
  - Default (mission): emit `mission: ${params.slug}` (current behavior, backward compatible)
- **Verify:** `npx vitest run src/__tests__/templates.test.ts`

### 4. Add scope to ParsedResource
- **File:** `src/dashboard/parser.ts` (lines 352-373)
- **What:** Add `scope: 'global' | 'workspace' | 'mission'` to the `ParsedResource` interface at line 352. In `parseResource()` at line 362, default scope to `'mission'` (caller overrides for global/workspace). Follow the `ParsedMemory` pattern at line 377 where `scope` is a string field.
- **Verify:** `npx vitest run src/__tests__/dashboard-parser.test.ts`

### 5. Expand ResourceSummary and WsMessageType
- **File:** `src/dashboard/types.ts`
- **What:**
  - Add `scope: 'global' | 'workspace' | 'mission'` to `ResourceSummary` at line 61. Add optional `workspace?: string` and `missionSlug?: string`.
  - Add `'resources-updated'` to `WsMessageType` union at line 318.
- **Verify:** TypeScript compiles (`npx tsc --noEmit`)

### 6. Add global/workspace resource list functions and merge in getMissionDetail
- **File:** `src/dashboard/api.ts`
- **What:**
  - Refactor `listResources()` at line 756 to accept a second param `scope: 'global' | 'workspace' | 'mission' = 'mission'` and an optional `scopeMeta?: { workspace?: string; missionSlug?: string }`. Set `scope`, `workspace`, and `missionSlug` on each returned `ResourceSummary`.
  - Add `listGlobalResources()` that calls `listResources(globalResourcesDir(), 'global')` using the path helper from task 1.
  - Add `listWorkspaceResources(workspaceName: string)` that calls `listResources(workspaceResourcesDir(workspaceName), 'workspace', { workspace: workspaceName })`.
  - In `getMissionDetail()` at line 482, replace `const resources = await listResources(missionPath)` with:
    ```ts
    const missionResources = await listResources(missionPath, 'mission', { missionSlug: slug });
    const globalResources = await listGlobalResources();
    const workspaceResources = mission.workspace
      ? await listWorkspaceResources(mission.workspace)
      : [];
    const resources = [...globalResources, ...workspaceResources, ...missionResources];
    ```
- **Verify:** `npx vitest run src/__tests__/dashboard-api.test.ts`

### 7. Scaffold workspace resource dirs
- **File:** `src/dashboard/api.ts` (line 256, `createWorkspace()`)
- **What:** After registering the workspace in `workspaces.json`, also create the workspace resource directory: `await ensureDir(workspaceResourcesDir(name))`. Write `_index.md` using `renderResourcesIndex({ slug: name, timestamp: new Date().toISOString(), scope: 'workspace', workspace: name })`.
- **Import:** Add `ensureDir`, `writeFileSafe` from `../utils/fs.js`, `workspaceResourcesDir` from `../utils/paths.js`, `renderResourcesIndex` from `../templates/index-stubs.js`.
- **Verify:** Create a workspace via POST `/api/workspaces`, verify `~/.syntaur/workspaces/<name>/resources/` exists with `_index.md`.

### 8. Add API routes
- **File:** `src/dashboard/server.ts`
- **What:** Add two routes near the existing workspace routes (lines 202-237):
  - `GET /api/resources` → calls `listGlobalResources()`, returns JSON array
  - `GET /api/workspaces/:name/resources` → validate `:name` matches `/^[a-z0-9][a-z0-9-]*$/` (reuse the validation pattern from POST at line 215), calls `listWorkspaceResources(name)`, returns JSON array
- **Also:** Pass `globalResourcesDir: globalResourcesDir()` to `createWatcher()` call at line 330.
- **Verify:** Build succeeds; `curl http://localhost:<port>/api/resources` returns `[]`

### 9. Add file watchers for global and workspace resources
- **File:** `src/dashboard/watcher.ts` (lines 5-11)
- **What:** Add `globalResourcesDir?: string` and `workspaceResourcesDirs?: string[]` to `WatcherOptions`. Create watchers following the servers watcher pattern (lines 70-102):
  - Global: debounce key `'__global-resources__'`, message type `'resources-updated'`
  - Workspace: iterate `workspaceResourcesDirs`, each gets debounce key `'__ws-resources-<dir>__'`, message type `'resources-updated'`
- **Also:** Add cleanup in `close()` at line 172.
- **Verify:** Build succeeds

### 10. Update frontend websocket and data hooks
- **File:** `dashboard/src/hooks/useWebSocket.ts` (line 4)
- **What:** Add `'resources-updated'` to the `WsMessage.type` union.
- **File:** `dashboard/src/hooks/useMissions.ts` (line 60)
- **What:** Add `scope: 'global' | 'workspace' | 'mission'` to the frontend `ResourceSummary` interface. In the mission detail hook, add a websocket listener for `'resources-updated'` that triggers a refetch (follow the pattern used for `'mission-updated'` / `'assignment-updated'`).
- **Verify:** `npm run build --prefix dashboard`

### 11. Update frontend resource UI
- **File:** `dashboard/src/pages/MissionDetail.tsx` (lines 291-308)
- **What:**
  - Change React key from `resource.slug` (line 300) to `` `${resource.scope}:${resource.slug}` `` to avoid collisions when the same slug exists at multiple scopes.
  - Add a small scope badge next to each resource name showing "Global", "Workspace", or "Mission". Use existing badge/pill patterns from the codebase (e.g., status badges on assignments).
  - Update empty-state description (line 295) from "Resources live at the mission level..." to "Resources can be global, workspace-scoped, or mission-scoped."
- **Verify:** `npm run build --prefix dashboard`; visual check in browser

### 12. Expand write boundaries in templates
- **Files:** `src/templates/cursor-rules.ts` (lines 49-58) and `src/templates/codex-agents.ts` (lines 82-91)
- **What:** In both files, expand the "Files you may WRITE" section:
  - Add item: `**Global resources** -- \`~/.syntaur/resources/<slug>.md\``
  - Add item: `**Workspace resources** (if mission has a workspace) -- \`~/.syntaur/workspaces/<workspace>/resources/<slug>.md\``
  - Update the directory tree diagram to show `resources/` at the `~/.syntaur/` root level and inside `workspaces/<name>/`
- **Verify:** `npx vitest run src/__tests__/templates.test.ts`

### 13. Update protocol docs
- **File:** `docs/protocol/spec.md`
  - Update directory tree (line 75) to include `~/.syntaur/resources/` and `~/.syntaur/workspaces/<name>/resources/`
  - Update "Resources and memories live at the mission level" (line 92) to explain three-scope model
  - Update shared-writable section (line 126) and file table (line 130) accordingly
- **File:** `docs/protocol/file-formats.md`
  - Add a note in section 15 (line 900) explaining resources can exist at global, workspace, or mission level
- **Verify:** Read updated docs for consistency

### 14. Update platform skill files and help text
- **File:** `platforms/claude-code/skills/syntaur-protocol/SKILL.md` (lines 19-20)
  - Add global and workspace resource paths alongside the existing mission path
- **File:** `platforms/codex/skills/syntaur-protocol/SKILL.md` (line 23)
  - Same update
- **File:** `src/dashboard/help.ts` (lines 136, 219, 227)
  - Update mission description text to mention global/workspace resources
  - Update "Resource" term definition to explain three-scope model
- **Verify:** Build succeeds

## Dependencies
- No new external packages required
- Workspace directories (`~/.syntaur/workspaces/<name>/`) are a new filesystem convention — currently workspaces only exist in `workspaces.json`
- Task ordering: 1 → 2-5 (parallel) → 6-7 (depend on 3, 4, 5) → 8-9 (depend on 6) → 10-11 (frontend, depend on 5) → 12-14 (docs, can run last)

## Verification
- `npx vitest run` — all existing tests pass
- `npm run build` — full build succeeds
- `npm run build --prefix dashboard` — dashboard build succeeds
- `npx tsc --noEmit` — no type errors
- Manual: run dashboard, create a global resource file at `~/.syntaur/resources/test.md`, verify it appears in mission detail with "Global" scope badge
- Manual: create a workspace, add a resource at `~/.syntaur/workspaces/<name>/resources/test.md`, verify it appears for missions in that workspace with "Workspace" badge
- Manual: verify existing mission-scoped resources still show with "Mission" badge
- Manual: create `test.md` at all three scopes for the same mission — verify all three appear with distinct keys and badges
