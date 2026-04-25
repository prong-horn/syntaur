# Add Project-Level Todos

**Date:** 2026-04-23
**Complexity:** small
**Tech Stack:** TypeScript (Node >= 20, ESM, tsup) · Express 5 · ws · chokidar · commander · React 19 + Vite + react-router-dom · Vitest
**Assignment branch:** add-project-level-todos

## Revision 2 — 2026-04-23

**Reason:** Codex review #2 (`/tmp/codex-plan-review-2.md`) flagged remaining DETAIL, ACCURACY, and GAPS items after Revision 1.

**What changed:**
- Task 5: Route shape disambiguated. Dropped `GET /list`; `GET /` IS the project list route. Count is now **14 routes** (no per-project aggregate — workspace `GET /api/todos` aggregate has no project-router equivalent).
- Task 5: Use `fileExists` from `src/utils/fs.ts:8` (not `pathExists`). Check `resolve(projectsDir, slug)` directory existence, matching `api-agent-sessions.ts:39-41` exactly.
- Task 5: Mitigate TOCTOU — re-check project existence **inside** the `withLock('proj:<slug>')` critical section before any parser write. Create only the `todos/` subdirectory explicitly (`mkdir todos/`, `mkdir todos/archive/`) rather than letting `writeChecklist`'s recursive `ensureDir` reconstruct a deleted project tree.
- Task 10: Drop proposed `'project-todos'` union member. Reuse existing `PaletteEntryType` `'todo'` (with route `/projects/:slug/todos`) to avoid cascading edits to `paletteIndex.ts:4`, `CommandPalette.tsx:12`, `fuzzy.ts:48`.
- Task 13: Semantic fix — "at most one" (not "exactly one"). Preserve no-flag default: `{ kind: 'workspace', id: '_global' }`, matching current `resolveWorkspace` at `src/commands/todo.ts:21`. Reject only true combos (two or more of `--project`/`--workspace`/`--global`).
- Task 13: Added CLI project-existence check — before parser call in project scope, `fileExists(resolve(readConfig().defaultProjectDir, slug, 'project.md'))` must be true; otherwise `todoCommand.error(`Project "${slug}" not found`)`. Prevents `todo add --project ghost` from silently creating a partial project tree.
- Task 15: Added three new test cases — (f) same-project concurrent writes preserve both items; (g) CLI no-flag behavior resolves to `{ kind: 'workspace', id: '_global' }` and writes under `getTodosDir()/_global.md`; (h) `syntaur todo add "x" --project ghost` exits non-zero and does NOT create `<projectsDir>/ghost/`.

## Revision 1 — 2026-04-23

**Reason:** Codex review (`/tmp/codex-plan-review.md`) flagged completeness, detail, and accuracy gaps.

**What changed:**
- Project todos dir resolves under the **configured** `config.defaultProjectDir` (injected as `projectsDir`), not the built-in `defaultProjectDir()` from `paths.ts`. Signature updated.
- Added explicit task to update workspace todo hooks with `!msg.projectSlug` WebSocket filter so workspace views don't refetch on project-scoped broadcasts.
- Added project-existence 404 validation in the new router (pattern: `src/dashboard/api-agent-sessions.ts:39`).
- Step 4 enumerates the exact routes (project-root, no `/:workspace` segment).
- Step 10 anchor corrected to `ProjectDetail.tsx:170+` (tabs array body, not props).
- Step 12 uses `todoCommand.error(...)` (commander subcommand) — `program` symbol does not exist in `src/commands/todo.ts`. Handler options split: `options.toProject` (assignment target) vs `options.project` (scope selector).
- Step 14 backup test sets a custom `config.defaultProjectDir` to prove project-todo coverage actually follows the configured path.
- Accuracy fixes: backup anchor is `github-backup.ts:64` (not :12/:71).

## Objective

Add a project-scoped todo checklist alongside the existing workspace-scoped todos. Storage is colocated under each project (`<config.defaultProjectDir>/<slug>/todos/<slug>.md` + `-log.md` + `archive/`), reusing the existing parser verbatim. Expose via a new HTTP sub-router, CLI scope flags, and a project-todos dashboard page.

## Assumptions & Constraints (what we are NOT doing)

- No parser changes. `src/todos/parser.ts` is scope-agnostic; keep the hard-coded `workspace:` frontmatter field (project slug is the value for project scope). `TodoChecklist.workspace` type name is retained as the scope-key field.
- No new backup category. Project todos ride along with the existing `projects` category backup at `src/utils/github-backup.ts:64`, which uses `config.defaultProjectDir`.
- No second chokidar watcher. Branch inside the existing projects watcher (`src/dashboard/watcher.ts:27`) when `parts[1] === 'todos'` — emit `todos-updated` with `projectSlug` populated.
- No sidebar changes. Project todos are project-scoped entries, not a global sidebar section.
- No schema migration. Feature is additive; existing workspace checklists untouched.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/paths.ts` | MODIFY | Add `projectTodosDir(projectsDir, slug)` accepting the configured projects root |
| `src/dashboard/api-todos.ts` | MODIFY | Composite lock keys (`ws:<name>` / `proj:<slug>`) |
| `src/dashboard/api-project-todos.ts` | CREATE | `createProjectTodosRouter(projectsDir, broadcast)` using `Router({ mergeParams: true })`; project-existence 404 |
| `src/dashboard/server.ts` | MODIFY | Mount new router at `/api/projects/:projectId/todos` |
| `src/dashboard/watcher.ts` | MODIFY | Branch on `parts[1] === 'todos'` → emit `todos-updated` with `projectSlug` |
| `dashboard/src/hooks/useTodos.ts` | MODIFY | Ignore project-scoped broadcasts (`!msg.projectSlug` guard) in all three WS handlers |
| `src/commands/todo.ts` | MODIFY | Add `--project <slug>` scope to all subcommands; rename `promote`'s existing `--project` flag to `--to-project` |
| `src/commands/dashboard.ts` | (no-op) | `projectsDir` already available to server factory (`src/commands/dashboard.ts:78,110`) |
| `dashboard/src/hooks/useProjectTodos.ts` | CREATE | Mirrors `useTodos` against `/api/projects/:projectId/todos`; WS filter `msg.type==='todos-updated' && msg.projectSlug===projectId` |
| `dashboard/src/pages/ProjectTodosPage.tsx` | CREATE | Copy of `WorkspaceTodosPage.tsx` parameterized on `:slug` |
| `dashboard/src/App.tsx` | MODIFY | Import + route at `/projects/:slug/todos` and workspace-prefixed mirror under `/w/:workspace/...` |
| `dashboard/src/lib/routes.ts` | MODIFY | Breadcrumb branch for `parts[2] === 'todos'` under projects in `buildShellMeta` (~:129-147) |
| `dashboard/src/hotkeys/paletteIndex.ts` | MODIFY | Add project-todos palette entries alongside current todo entries at :109-121 |
| `dashboard/src/pages/ProjectDetail.tsx` | MODIFY | Add "Todos" tab to existing `ContentTabs` items array (~:170+) |
| `docs/protocol/file-formats.md` | MODIFY | New section: project-scoped todos, distinct from assignment `## Todos` body sections; backup inherits from `projects` category |
| `src/__tests__/paths.test.ts` | MODIFY | Add case for `projectTodosDir(projectsDir, slug)` |
| `src/__tests__/dashboard-api-project-todos.test.ts` | CREATE | Router integration tests (collision, isolation both directions, 404 on unknown project) |
| `src/__tests__/github-backup.test.ts` | MODIFY | Set custom `defaultProjectDir`; assert project todos included via `projects` category backup |

## Tasks

### 1. Path helper
- **File:** `src/utils/paths.ts` (MODIFY)
- **What:** Export `projectTodosDir(projectsDir: string, projectSlug: string): string` returning `resolve(projectsDir, projectSlug, 'todos')`. Signature takes the configured projects root explicitly — callers pass `config.defaultProjectDir` (dashboard/router) or `readConfig().defaultProjectDir` (CLI). Do NOT re-export a zero-arg variant that falls back to the built-in `defaultProjectDir()` — this would silently diverge from the dashboard/backup root.
- **Pattern:** Mirror `todosDir()` at :35-37 but with explicit `projectsDir` arg.
- **Verify:** `npm run typecheck`

### 2. Confirm parser reuse (no edits)
- **File:** `src/todos/parser.ts` (read-only)
- **What:** Confirm `readChecklist`, `writeChecklist`, `readLog`, `appendLogEntry`, `checklistPath`, `logPath`, `archivePath` all accept `todosDir` as first arg (:214-253, :255-295) and persist `workspace: <slug>` frontmatter. For project scope, the slug is the value written. No code change.
- **Verify:** `npm run test -- todos-parser`

### 3. Fix workspace lock-key collision (pre-req)
- **File:** `src/dashboard/api-todos.ts` (MODIFY :25-31)
- **What:** Change `writeLocks` key format from bare workspace name to `ws:<name>`. Update every `withLock` call site within this file to prefix the key. Prevents collision with incoming `proj:<slug>` keys in the new router.
- **Pattern:** Same `Map<string, Promise<void>>` structure, just prefixed keys.
- **Verify:** `npm run test -- dashboard-api`

### 4. Workspace hook WS filter (pre-req for UI)
- **File:** `dashboard/src/hooks/useTodos.ts` (MODIFY :27, :56, :87 — all three `useWebSocket((msg) => { if (msg.type === 'todos-updated') fetchData(); })` call sites in `useTodos`, `useAllTodos`, `useTodoLog`)
- **What:** Tighten the filter to `msg.type === 'todos-updated' && !msg.projectSlug`. Project-scoped broadcasts carry `projectSlug`; workspace hooks should ignore them to avoid needless refetches when a project todo changes.
- **Pattern:** `WsMessage.projectSlug` already exists at `src/dashboard/types.ts:384`; existing workspace broadcast in `api-todos.ts` does not populate it, so the guard is safe for current behavior.
- **Verify:** `npm run build:dashboard`

### 5. Project todos router
- **File:** `src/dashboard/api-project-todos.ts` (CREATE)
- **What:** Export `createProjectTodosRouter(projectsDir: string, broadcast: (msg: WsMessage)=>void)` returning `Router({ mergeParams: true })` so `:projectId` from the parent mount is accessible in handlers. **14 routes** (no all-projects aggregate — workspace `GET /api/todos` has no equivalent here):
  - `GET /` — list this project's todos (equivalent of workspace `GET /:workspace`)
  - `POST /` — add
  - `POST /reorder`
  - `GET /log`
  - `POST /archive`
  - `GET /log/:id`
  - `GET /:id`
  - `PATCH /:id`
  - `DELETE /:id`
  - `POST /:id/start`, `POST /:id/complete`, `POST /:id/block`, `POST /:id/reopen`, `POST /:id/unblock`

  **Implementation rules:**
  - On every handler, first validate `req.params.projectId` with `isValidSlug` from `src/utils/slug.ts:11-13`. On invalid: `res.status(400).json({ error: 'Invalid project slug' }); return;`.
  - Then check project existence using `fileExists` from `src/utils/fs.ts:8`: `const projectDir = resolve(projectsDir, req.params.projectId); if (!(await fileExists(projectDir))) { res.status(404).json({ error: `Project "${req.params.projectId}" not found` }); return; }` — pattern copied verbatim from `src/dashboard/api-agent-sessions.ts:39-41` (check dir existence, not `project.md`).
  - Resolve todos dir per-request via `projectTodosDir(projectsDir, req.params.projectId)`.
  - **TOCTOU mitigation on write paths (POST/PATCH/DELETE/POST /:id/*):** inside the `withLock('proj:<slug>')` critical section, re-run `await fileExists(projectDir)` before any parser call. If the project disappeared, return 404 and do NOT write. Additionally, before calling `writeChecklist` or `appendLogEntry` for the first time, create only the `todos/` subdir (`mkdir(projectTodosDir(projectsDir, slug), { recursive: false })` catching `EEXIST`) and `todos/archive/` — do not rely on parser-side recursive `ensureDir` that would re-create a deleted project parent.
  - Use composite lock keys `proj:<slug>` in this file's own `writeLocks` map. Do not share the workspace `writeLocks` map.
  - `broadcastUpdate(slug)` emits `{ type:'todos-updated', projectSlug: slug, timestamp }` (populate `projectSlug` on the existing `WsMessage` field).
- **Pattern:** Route surface & handler bodies copied from `api-todos.ts:57-445`; substitute scope-resolution, lock prefix, broadcast payload, and the validation preamble only.
- **Verify:** `npm run typecheck`

### 6. Mount router in server
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** Import `createProjectTodosRouter`; pass the existing `projectsDir` option (already plumbed through `src/commands/dashboard.ts:78,110`) and the existing `broadcast`. Mount with `app.use('/api/projects/:projectId/todos', createProjectTodosRouter(projectsDir, broadcast))` adjacent to line 362.
- **Pattern:** Match ordering of existing routers at :352-365.
- **Verify:** `npm run typecheck`

### 7. Watcher branch for project todos
- **File:** `src/dashboard/watcher.ts` (MODIFY :27-65)
- **What:** In `handleProjectChange`, after the existing `parts[1] === 'assignments'` check, add `else if (parts[1] === 'todos')` branch that emits `{ type: 'todos-updated', projectSlug, timestamp }`. Debounce key `todos:${projectSlug}` (safe vs. existing keys `projectSlug`, `projectSlug/assignmentSlug`, `__todos__` because a `:` cannot appear in a valid slug). Do NOT fall through to the default `project-updated` emission.
- **Pattern:** Same `pendingEvents` / `setTimeout` debounce structure at :52-64.
- **Verify:** `npm run test -- watcher` (if present) or `npm run typecheck`

### 8. React hook
- **File:** `dashboard/src/hooks/useProjectTodos.ts` (CREATE)
- **What:** `useProjectTodos(projectId)`, `useProjectTodoLog(projectId)`, `useAllProjectTodos()` if aggregate is needed, plus mutation helpers mirroring those present in `dashboard/src/hooks/useTodos.ts:96-156`: `addProjectTodo`, `completeProjectTodo`, `startProjectTodo`, `blockProjectTodo`, `reopenProjectTodo`, `unblockProjectTodo`, `deleteProjectTodo`, `reorderProjectTodos` (plus `patchProjectTodo`/`archiveProjectTodos` ONLY if the workspace source file already exports equivalents — check before including). WebSocket filter: `msg.type === 'todos-updated' && msg.projectSlug === projectId`. Endpoints hit `/api/projects/:projectId/todos/...`.
- **Pattern:** Mirror `dashboard/src/hooks/useTodos.ts` incl. the colocated mutation helpers at :96-156. Match exactly the helpers that already exist — do not invent new ones.
- **Verify:** `npm run build:dashboard`

### 9. Project todos page
- **File:** `dashboard/src/pages/ProjectTodosPage.tsx` (CREATE)
- **What:** Copy `WorkspaceTodosPage.tsx` structure. Replace `useParams<{workspace}>()` with `useParams<{slug}>()`. Swap `useTodos` for `useProjectTodos`.
- **Verify:** `npm run build:dashboard`

### 10. Routes + breadcrumbs + palette
- **File:** `dashboard/src/App.tsx` (MODIFY :26-27, :56-65, :67-81)
- **What:** Import `ProjectTodosPage`; add `<Route path="/projects/:slug/todos" element={<ProjectTodosPage/>} />` in the default route block, and `<Route path="/w/:workspace/projects/:slug/todos" .../>` in the workspace-prefixed block.
- **File:** `dashboard/src/lib/routes.ts` (MODIFY `buildShellMeta` ~:129-147)
- **What:** Add breadcrumb case for `parts[2] === 'todos'` under `/projects/:slug/` → label "Todos" nested under project.
- **File:** `dashboard/src/hotkeys/paletteIndex.ts` (MODIFY :109-121)
- **What:** Emit palette entries per known project pointing at `/projects/:slug/todos`. **Reuse** the existing `PaletteEntryType` value `'todo'` (declared at `dashboard/src/hotkeys/paletteIndex.ts:4`) — do NOT add a new union member. Adding one would cascade through `dashboard/src/hotkeys/paletteIndex.ts:4`, `dashboard/src/hotkeys/CommandPalette.tsx:12`, and `dashboard/src/hotkeys/fuzzy.ts:48` (type-narrowing / grouping), which is out of scope. Distinguish project todo entries from workspace todo entries by including the project slug in the `subtitle` or `keywords` rather than a new type.
- **Verify:** `npm run build:dashboard`

### 11. Project detail "Todos" tab
- **File:** `dashboard/src/pages/ProjectDetail.tsx` (MODIFY around :170+ where the `ContentTabs` `items` array is defined)
- **What:** Append a new `{ value: 'todos', label: 'Todos', content: <Link to={`${wsPrefix}/projects/${project.slug}/todos`}>Open project todos</Link> }` entry. Link out rather than embed to avoid double-fetching the same todos in the tab. Use whatever `wsPrefix` helper is in scope at that call site (check neighboring tabs).
- **Verify:** `npm run build:dashboard`

### 12. CLI — flag rename (breaking change on `todo promote`)
- **File:** `src/commands/todo.ts` (MODIFY around the existing `todo promote` block — find via `.command('promote')` declaration)
- **What:** On `todo promote`, rename the existing `--project <slug>` (target assignment project) to `--to-project <slug>`. Update `.requiredOption`/`.option` line and every read in the handler body from `options.project` to `options.toProject`. This frees `--project` for scope selection in task 13.
- **Verify:** `npm run typecheck`; `npx syntaur todo promote --help` shows `--to-project`, not `--project`.

### 13. CLI — scope resolver across subcommands
- **File:** `src/commands/todo.ts` (MODIFY)
- **What:** Add `resolveScope({ project?, workspace?, global? }): { kind: 'project'|'workspace', id: string }` next to `resolveWorkspace` at :19-30. Semantics — **at most one** of the three flags may be present; no-flag is a valid case. Precedence:
  - `project` set → `{ kind: 'project', id: project }` (validate with `isValidSlug`; emit `todoCommand.error(`Invalid project slug "${project}"`)` if invalid).
  - `global` true OR neither `project` nor `workspace` set → `{ kind: 'workspace', id: '_global' }` — preserves existing default behavior at `src/commands/todo.ts:21`.
  - `workspace` set → `{ kind: 'workspace', id: workspace }`.
  - Two or more of `project`/`workspace`/`global` set → `todoCommand.error('Use at most one of --project, --workspace, --global')`.
  - **Project existence check (CLI):** in the `kind==='project'` branch, before any parser call, `const projectDir = resolve(readConfig().defaultProjectDir, id); if (!(await fileExists(projectDir))) { todoCommand.error(`Project "${id}" not found`); }`. Import `fileExists` from `../utils/fs.js`. This prevents `todo add --project ghost` from triggering parser-side `ensureDir` that would silently create `<projectsDir>/ghost/todos/`.
  - **TOCTOU note:** CLI is single-process so inline check is sufficient; no lock needed as CLI writes are not synchronized (matches existing workspace-todo CLI behavior — see Risks).

  Add `--project <slug>` option to each subcommand declaration: `add` (:39), `list` (:65), `start` (:116), `complete` (:147), `block` (:188), `unblock` (:228), `delete`, `edit`, `tag`, `log`, `archive`, `promote` (where it now means SOURCE scope; target project is `--to-project` from task 12). In each action body, after `resolveScope`, resolve `todosPath`:
  - `kind==='project'` → `projectTodosDir(readConfig().defaultProjectDir, id)` and pass `id` as the scope key (written to frontmatter `workspace:` field).
  - `kind==='workspace'` → `getTodosDir()` and pass `id` (which will be `_global` or a workspace slug) as the scope key.
- **Pattern:** Reuse every existing parser call site unchanged; swap only the two inputs (todos dir and scope key).
- **Verify:** `npm run typecheck`; `npx syntaur todo add "foo" --project test-proj` round-trips; `npx syntaur todo add "foo" --project x --workspace y` errors with "Use at most one..."; `npx syntaur todo add "foo" --project ghost` (non-existent project) errors with "Project not found" and does NOT create `<projectsDir>/ghost/`; `npx syntaur todo add "foo"` (no flags) still writes to `getTodosDir()/_global.md`.

### 14. Protocol docs
- **File:** `docs/protocol/file-formats.md` (MODIFY around :188-284 and :1220/:1255)
- **What:** Add a new subsection for project-scoped todos: storage path (`<config.defaultProjectDir>/<slug>/todos/<slug>.md` + `-log.md` + `archive/`), relationship to workspace todos (parallel, separate scope), distinction from assignment-level `## Todos` body sections (different concept — project todos are external flat checklists). Note that the `projects` backup category automatically covers them (anchor: `src/utils/github-backup.ts:64`); no new category. Document that the frontmatter field is `workspace:` even for project-scoped files (the slug is the project slug) and why the name was kept.
- **Verify:** grep for "project todos" section header in output.

### 15. Tests
- **File:** `src/__tests__/paths.test.ts` (MODIFY)
- **What:** Add case asserting `projectTodosDir('/custom/root', 'my-proj')` resolves to `/custom/root/my-proj/todos` exactly. Also assert `SYNTAUR_HOME` has NO effect on this helper (it's independent of the built-in default).
- **File:** `src/__tests__/dashboard-api-project-todos.test.ts` (CREATE)
- **What:** Mkdtemp a `projectsDir` containing two project dirs (`alpha`, `beta`) each with a `project.md` marker. Boot Express with the new router mounted. Assert:
  - (a) concurrent writes to `alpha` and `beta` (cross-project) do not collide (lock keys distinct) and both persist.
  - (b) `GET /api/todos` aggregate (with workspace router also mounted) does NOT include project todos.
  - (c) `GET /api/projects/alpha/todos` does NOT include workspace or `beta` todos.
  - (d) `GET /api/projects/ghost/todos` returns 404 with the "not found" error.
  - (e) `GET /api/projects/INVALID_SLUG/todos` returns 400.
  - (f) concurrent writes to the SAME project (`alpha` twice in parallel) preserve BOTH items (lock serializes correctly).
- **Pattern:** Mimic `src/__tests__/dashboard-api.test.ts:1-60` scaffolding.
- **File:** `src/__tests__/github-backup.test.ts` (MODIFY)
- **What:** Add a case setting `config.defaultProjectDir` to a custom mkdtemp path, seeding `<projectsDir>/<slug>/todos/<slug>.md`, running the `projects` category backup, and asserting the todo file is present in the backup repo output. No new category expected; the test must operate on the custom path (not the built-in default) to prove the configured path is actually backed up.
- **File:** `src/__tests__/cli-todo-scope.test.ts` (CREATE)
- **What:** CLI-level tests for scope resolution:
  - (g) `syntaur todo add "foo"` (no flags) writes to `getTodosDir()/_global.md` — verify on-disk content and exit 0.
  - (h) `syntaur todo add "foo" --project ghost` exits non-zero, prints "Project not found", and does NOT create `<projectsDir>/ghost/` on disk (assert directory absence after the process exits).
  - (i) `syntaur todo add "foo" --project x --workspace y` exits non-zero with "Use at most one...".
  Use a temp `SYNTAUR_HOME` and temp `config.defaultProjectDir`; spawn the CLI via `execa`/`child_process` or call the command's action fn directly if exposed.
- **Verify:** `npm run test`

## Dependencies

- None new. `isValidSlug` in `src/utils/slug.ts:11`, `projectsDir` wiring in `src/dashboard/server.ts` + `src/commands/dashboard.ts:78,110`, `config.defaultProjectDir` in `src/utils/config.ts:75,89`, and `WsMessage.projectSlug` in `src/dashboard/types.ts:384` all already exist.

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
- **Frontmatter field name.** The parser writes `workspace: <slug>` even when the slug is a project. Acceptable per scout findings; documented in task 14.
- **CLI writes are not lock-synchronized.** Matches today's workspace-todo CLI behavior (no file lock). API writes are protected via the per-scope `writeLocks` maps; CLI concurrent runs could still interleave, same as before. Not in scope for this assignment.
- **Palette entry volume.** Adding one entry per project multiplies palette index size. Likely fine; revisit if noticeable.
