# Add Project-Level Todos

**Date:** 2026-04-23
**Complexity:** small
**Tech Stack:** TypeScript (Node >= 20, ESM, tsup) · Express 5 · ws · chokidar · commander · React 19 + Vite + react-router-dom · Vitest
**Assignment branch:** add-project-level-todos

## Objective

Add a project-scoped todo checklist alongside the existing workspace-scoped todos. Storage is colocated under each project (`~/.syntaur/projects/<slug>/todos/<slug>.md` + `-log.md` + `archive/`), reusing the existing parser verbatim. Expose via a new HTTP sub-router, CLI scope flags, and a project-todos dashboard page.

## Assumptions & Constraints (what we are NOT doing)

- No parser changes. `src/todos/parser.ts` is scope-agnostic; keep the hard-coded `workspace:` frontmatter field (project slug is the value for project scope). `TodoChecklist.workspace` type name is retained as the scope-key field.
- No new backup category. Project todos ride along with the existing `projects` category in `src/utils/github-backup.ts:12` (the dir is colocated under `defaultProjectDir`).
- No second chokidar watcher. Branch inside the existing projects watcher (`src/dashboard/watcher.ts:27`) when `parts[1] === 'todos'` — emit `todos-updated` with `projectSlug` populated.
- No sidebar changes. Project todos are project-scoped entries, not a global sidebar section.
- No schema migration. Feature is additive; existing workspace checklists untouched.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/paths.ts` | MODIFY | Add `projectTodosDir(slug)` |
| `src/dashboard/api-todos.ts` | MODIFY | Composite lock keys (`ws:<name>` / `proj:<slug>`) |
| `src/dashboard/api-project-todos.ts` | CREATE | `createProjectTodosRouter(projectsDir, broadcast)` using `Router({ mergeParams: true })` |
| `src/dashboard/server.ts` | MODIFY | Mount new router at `/api/projects/:projectId/todos` |
| `src/dashboard/watcher.ts` | MODIFY | Branch on `parts[1] === 'todos'` → emit `todos-updated` with `projectSlug` |
| `src/commands/todo.ts` | MODIFY | Add `--project <slug>` (scope) to all subcommands; rename `promote`'s existing `--project` flag to `--to-project` |
| `src/commands/dashboard.ts` | (no-op) | `projectsDir` already available to server factory |
| `dashboard/src/hooks/useProjectTodos.ts` | CREATE | Mirrors `useTodos` against `/api/projects/:projectId/todos`; WS filter `msg.type==='todos-updated' && msg.projectSlug===projectId` |
| `dashboard/src/pages/ProjectTodosPage.tsx` | CREATE | Copy of `WorkspaceTodosPage.tsx` parameterized on `:slug` |
| `dashboard/src/App.tsx` | MODIFY | Import + route at `/projects/:slug/todos` and workspace-prefixed mirror under `/w/:workspace/...` |
| `dashboard/src/lib/routes.ts` | MODIFY | Breadcrumb branch for `parts[2] === 'todos'` under projects in `buildShellMeta` (~:129-147) |
| `dashboard/src/hotkeys/paletteIndex.ts` | MODIFY | Add project-todos palette entries alongside current todo entries at :109-121 |
| `dashboard/src/pages/ProjectDetail.tsx` | MODIFY | Add "Todos" tab to existing `ContentTabs` at :41-58 |
| `docs/protocol/file-formats.md` | MODIFY | New section: project-scoped todos, distinct from assignment `## Todos` body sections; backup inherits from `projects` |
| `src/__tests__/paths.test.ts` | MODIFY | Add case for `projectTodosDir()` |
| `src/__tests__/dashboard-api-project-todos.test.ts` | CREATE | Router integration tests (collision, isolation both directions) |
| `src/__tests__/github-backup.test.ts` | MODIFY | Assert project todos included via `projects` category backup |

## Tasks

### 1. Path helper
- **File:** `src/utils/paths.ts` (MODIFY)
- **What:** Export `projectTodosDir(projectSlug: string): string` returning `resolve(defaultProjectDir(), projectSlug, 'todos')`. No validation (caller validates with `isValidSlug`).
- **Pattern:** Mirror `todosDir()` at :35-37.
- **Verify:** `npm run typecheck`

### 2. Confirm parser reuse (no edits)
- **File:** `src/todos/parser.ts` (read-only)
- **What:** Confirm `readChecklist`, `writeChecklist`, `readLog`, `appendLogEntry`, `checklistPath`, `logPath`, `archivePath` all accept `todosDir` as first arg (:214-253, :255-295) and persist `workspace: <slug>` frontmatter. For project scope, the slug is the value written. No code change.
- **Verify:** `npm run test -- todos-parser`

### 3. Fix workspace lock-key collision (pre-req)
- **File:** `src/dashboard/api-todos.ts` (MODIFY :25-31)
- **What:** Change `writeLocks` key format from bare workspace name to `ws:<name>`. Update `withLock` call site(s). Prevents collision with incoming `proj:<slug>` keys in the new router.
- **Pattern:** Same `Map<string, Promise<void>>` structure, just prefixed keys.
- **Verify:** `npm run test -- dashboard-api`

### 4. Project todos router
- **File:** `src/dashboard/api-project-todos.ts` (CREATE)
- **What:** Export `createProjectTodosRouter(projectsDir: string, broadcast: (msg: WsMessage)=>void)` returning `Router({ mergeParams: true })`. Mirror the 14 routes in `api-todos.ts:33-453` but:
  - Validate `:projectId` with `isValidSlug` from `src/utils/slug.ts:11-13` (do not redeclare the regex).
  - Resolve todos dir per-request via `projectTodosDir(req.params.projectId)`.
  - Use composite lock keys `proj:<slug>`.
  - `broadcastUpdate()` emits `{ type:'todos-updated', projectSlug, timestamp }` (populate `projectSlug` on the existing `WsMessage` field).
- **Pattern:** Route surface & handler bodies copied from `api-todos.ts:57-453`; substitute scope-resolution only.
- **Verify:** `npm run typecheck`

### 5. Mount router in server
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Import `createProjectTodosRouter`; mount with `app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast))` adjacent to line 362.
- **Pattern:** Match ordering of existing routers at :352-365.
- **Verify:** `npm run typecheck`

### 6. Watcher branch for project todos
- **File:** `src/dashboard/watcher.ts` (MODIFY :27-65)
- **What:** In `handleProjectChange`, after the existing `parts[1] === 'assignments'` check, add `else if (parts[1] === 'todos')` branch that emits `{ type: 'todos-updated', projectSlug, timestamp }`. Debounce key `todos:${projectSlug}`. Do not fall through to the default `project-updated` emission.
- **Pattern:** Same `pendingEvents` / `setTimeout` debounce structure at :52-64.
- **Verify:** `npm run test -- watcher` (if present) or `npm run typecheck`

### 7. React hook
- **File:** `dashboard/src/hooks/useProjectTodos.ts` (CREATE)
- **What:** `useProjectTodos(projectId)`, `useProjectTodoLog(projectId)`, `useAllProjectTodos()` (if needed), plus add/complete/start/block/reopen/unblock/delete/patch/reorder/archive mutation helpers. Hit `/api/projects/:projectId/todos/...`. WebSocket filter: `msg.type === 'todos-updated' && msg.projectSlug === projectId`.
- **Pattern:** Mirror `dashboard/src/hooks/useTodos.ts` incl. the colocated mutation helpers at :96-156.
- **Verify:** `npm run build:dashboard`

### 8. Project todos page
- **File:** `dashboard/src/pages/ProjectTodosPage.tsx` (CREATE)
- **What:** Copy `WorkspaceTodosPage.tsx` structure. Replace `useParams<{workspace}>()` with `useParams<{slug}>()`. Swap `useTodos` for `useProjectTodos`.
- **Verify:** `npm run build:dashboard`

### 9. Routes + breadcrumbs + palette
- **File:** `dashboard/src/App.tsx` (MODIFY :26-27, :56-65, :67-81)
- **What:** Import `ProjectTodosPage`; add `<Route path="/projects/:slug/todos" element={<ProjectTodosPage/>} />` in the default route block, and `<Route path="/w/:workspace/projects/:slug/todos" .../>` in the workspace-prefixed block.
- **File:** `dashboard/src/lib/routes.ts` (MODIFY `buildShellMeta` ~:129-147)
- **What:** Add breadcrumb case for `parts[2] === 'todos'` under `/projects/:slug/` → label "Todos" nested under project.
- **File:** `dashboard/src/hotkeys/paletteIndex.ts` (MODIFY :109-121)
- **What:** Emit palette entries per known project pointing at `/projects/:slug/todos`; reuse an existing project-scoped type or add `'project-todos'`.
- **Verify:** `npm run build:dashboard`

### 10. Project detail "Todos" tab
- **File:** `dashboard/src/pages/ProjectDetail.tsx` (MODIFY :41-58)
- **What:** Add a "Todos" entry to the existing `ContentTabs` tabs array. The tab can either render `ProjectTodosPage` content inline or link out to `/projects/:slug/todos`.
- **Verify:** `npm run build:dashboard`

### 11. CLI — flag rename
- **File:** `src/commands/todo.ts` (MODIFY :466-473)
- **What:** On `todo promote`, rename the existing `--project <slug>` (target assignment project) to `--to-project <slug>`. Update `.requiredOption` line and the handler body reference. This frees `--project` for scope selection and avoids collision in step 12.
- **Verify:** `npm run typecheck`; `npx syntaur todo promote --help`

### 12. CLI — scope resolver across subcommands
- **File:** `src/commands/todo.ts` (MODIFY :19-30 + all subcommand action bodies)
- **What:** Add `resolveScope({ project?, workspace?, global? }): { kind: 'project'|'workspace', id: string }` next to `resolveWorkspace`. Validate `project` with `isValidSlug`. Reject combos (`--project` with `--workspace` or `--global`) via `program.error()`. Add `--project <slug>` option to: add, list, start, complete, block, unblock, delete, edit, tag, log, archive, promote. In each action, resolve `todosPath`:
  - `kind==='project'` → `projectTodosDir(id)` + pass `id` as the scope-key (written to frontmatter `workspace:` field).
  - `kind==='workspace'` → `getTodosDir()` + pass existing workspace slug.
- **Pattern:** Reuse every existing parser call site unchanged; swap only the two inputs.
- **Verify:** `npm run typecheck`; `npx syntaur todo add "foo" --project test-proj` round-trips.

### 13. Protocol docs
- **File:** `docs/protocol/file-formats.md` (MODIFY around :188-284 and :1220/:1255)
- **What:** Add a new subsection for project-scoped todos: storage path, relationship to workspace todos (parallel, separate scope), distinction from assignment-level `## Todos` body sections (different concept — project todos are external flat checklists). Note that the `projects` backup category (`src/utils/github-backup.ts:12`) automatically covers them; no new category.
- **Verify:** grep for "project todos" section header in output.

### 14. Tests
- **File:** `src/__tests__/paths.test.ts` (MODIFY)
- **What:** Add case asserting `projectTodosDir('my-proj')` resolves under `defaultProjectDir()/my-proj/todos` honoring `SYNTAUR_HOME`.
- **File:** `src/__tests__/dashboard-api-project-todos.test.ts` (CREATE)
- **What:** Mkdtemp two projects with identically-named todo IDs; boot Express with the new router mounted; assert:
  - (a) concurrent writes to both projects do not collide (lock keys distinct) and both persist.
  - (b) `GET /api/todos` aggregate does NOT include project todos.
  - (c) `GET /api/projects/:id/todos` does NOT include workspace todos.
- **Pattern:** Mimic `src/__tests__/dashboard-api.test.ts:1-60` scaffolding.
- **File:** `src/__tests__/github-backup.test.ts` (MODIFY)
- **What:** Add a case seeding `<projectsDir>/<slug>/todos/<slug>.md` and asserting the `projects` category backup includes it. No new category expected.
- **Verify:** `npm run test`

## Dependencies

- None new. `isValidSlug` in `src/utils/slug.ts`, `projectsDir` wiring in `src/dashboard/server.ts`, and `WsMessage.projectSlug` in `src/dashboard/types.ts` already exist.

## Verification

```
npm run typecheck
npm run test
npm run build:dashboard
```

Manual smoke:
```
npx syntaur todo add "hello" --project some-project
npx syntaur todo list --project some-project
# dashboard: visit /projects/some-project/todos
```

## Risks / Open Questions

- **Lock-key collision (fixed by design).** Task 3 migrates existing workspace locks to `ws:<name>` before the new router introduces `proj:<slug>`. Any in-flight PR that still uses bare workspace keys must be rebased.
- **`todo promote --project` rename is a breaking CLI change.** Users currently pass `--project <slug>` to mean "target project for the new assignment". Renaming to `--to-project <slug>` is required to make room for scope selection. Mitigation options (pick one during implementation, flag for user): (a) hard-rename and call it out in the next release notes; (b) accept both flags for one release with a deprecation warning on `--project` when used under `promote`. Default to (a) unless the user requests otherwise.
- **Frontmatter field name.** The parser writes `workspace: <slug>` even when the slug is a project. Acceptable per scout findings, but worth a docs note so readers aren't confused when inspecting project todo files.
- **Palette entry volume.** Adding one entry per project multiplies palette index size. Likely fine; revisit if noticeable.
