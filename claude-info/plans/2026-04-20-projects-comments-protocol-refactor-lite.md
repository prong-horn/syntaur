# Projects + Comments + Standalone Assignments Protocol Refactor (v1.0 → v2.0)

**Date:** 2026-04-20
**Complexity:** medium
**Tech Stack:** TypeScript (ESM, Node 20+), Commander CLI, Express 5 + ws, React 19 + React Router + Vite, Vitest, tsup, better-sqlite3, Ink TUI

## Objective

Protocol version bump from v1.0 → v2.0. Rename `mission` → `project` everywhere (paths, CLI flags, config, dashboard routes, templates), integrate standalone assignments at `~/.syntaur/assignments/<uuid>/`, add a configurable `type` field to assignment frontmatter, extract `progress.md` and `comments.md` as separate append-only files (replacing the inline `## Progress` and `## Questions & Answers` sections), add cross-assignment wiki backlinks + `syntaur request` todo injection, and teach both skill platforms to better leverage `decision-record.md`. Hard cutover — no migration, no backward-compat. Syntaur has no users yet.

## Hard Constraints (read before every chunk)

- **Platform mirror.** Every `platforms/claude-code/` edit has a matching `platforms/codex/` edit AND matching `src/templates/codex-agents.ts`, `src/templates/cursor-rules.ts`, `src/templates/opencode-config.ts` updates. `src/__tests__/adapter-templates.test.ts` asserts substrings — update in lockstep.
- **Single-writer per assignment folder.** Comments and cross-assignment requests are peer-initiated → CLI-mediated. Progress is self-initiated by the owning agent → direct write, no CLI mediation.
- **Hook scripts:** `bash -n platforms/claude-code/hooks/enforce-boundaries.sh` (and codex mirror, session-cleanup.sh) after every edit.
- **Type safety:** `npm run typecheck` and `cd dashboard && npx tsc -b --noEmit` after each chunk.
- **Targeted test:** `npx vitest run src/__tests__/adapter-templates.test.ts` after any adapter/skill text change.
- **Full test before tag:** `npx vitest run` green, no skipped tests added silently.

## Rename Discipline (mission → project)

Renaming spans 237+ files. Safe approach:

1. **Identifier-by-identifier with context**, not blind regex. Use `Edit` with `replace_all` scoped to individual files. For each identifier rename, search first with `Grep` to scope the change.
2. **Canonical rename table.** Apply exactly these token renames (case-sensitive, whole-word where noted):
   - `mission` → `project` (lowercase, path segments, slug fields, variables)
   - `Mission` → `Project` (PascalCase types, React component names)
   - `MISSION` → `PROJECT` (uppercase constants)
   - `missions` → `projects` (directory names, plural variables)
   - `Missions` → `Projects` (component names, labels)
   - `missionSlug` → `projectSlug` (field names — note: in v2.0 frontmatter the field is named `project`, not `projectSlug`; `projectSlug` is only the internal TS variable / returned context)
   - `missionTitle` → `projectTitle`
   - `missionDir` → `projectDir`
   - `missionsDir` → `projectsDir`
   - `defaultMissionDir` → `defaultProjectDir`
   - `buildMissionRollup` → `buildProjectRollup`
   - `listMissions` → `listProjects`
   - `getMissionDetail` → `getProjectDetail`
   - `parseMission` → `parseProject`
   - `ParsedMission` → `ParsedProject`
   - `renderMission` → `renderProject`
   - `MissionParams` → `ProjectParams`
   - `MissionRecord` / `MissionSummary` → `ProjectRecord` / `ProjectSummary`
   - CLI flag `--mission` → `--project` (source: `.option('--mission <slug>', ...)` in `src/index.ts` plus each lifecycle command)
   - Frontmatter field `mission:` → `project:` (in `manifest.ts`, `index-stubs.ts`)
   - Subcommand `create-mission` → `create-project`
3. **User-facing text.** "Mission" (capitalized English noun) in CLI output, help text, skill docs, UI labels → "Project". Keep the rename holistic.
4. **Exempt strings.** Git commit messages before this refactor; test fixtures embedded in `.test.ts` that reference historical mission-shaped content are updated too (we have no v1 users, no fixture compat needed).
5. **Verification per chunk:** `Grep pattern="mission" path="src"` and `Grep pattern="Mission" path="src"` should return **zero matches** after chunk 1 (except in this plan itself, commit messages, or delete-targets awaiting removal). Same for `dashboard/`, `platforms/`, `docs/`.

## Files

High-level file plan across all chunks. Per-chunk file lists are embedded in each chunk's task section.

| Scope | Files |
|-------|-------|
| Templates | `src/templates/{assignment,manifest,index-stubs}.ts` MODIFY; `src/templates/mission.ts` → `project.ts` RENAME+MODIFY; `src/templates/{progress,comments}.ts` CREATE; `src/templates/{agent,claude}.ts` DELETE; `src/templates/{codex-agents,cursor-rules,opencode-config}.ts` MODIFY; `src/templates/index.ts` MODIFY |
| CLI | `src/commands/create-mission.ts` → `create-project.ts` RENAME+MODIFY; `src/commands/create-assignment.ts` MODIFY (flag + `--type` + standalone); `src/commands/{comment,request}.ts` CREATE; `src/commands/{assign,start,review,complete,block,unblock,fail,reopen}.ts` MODIFY (flag + by-UUID); `src/commands/{track-session,setup-adapter,browse,todo,init,dashboard}.ts` MODIFY; `src/index.ts` MODIFY (register commands, flag rename) |
| Utils | `src/utils/paths.ts` MODIFY (rename helper, add `assignmentsDir()`); `src/utils/config.ts` MODIFY (field + version + `types`); `src/utils/assignment-resolver.ts` REWRITE (from scratch under v2 names); `src/utils/doctor/checks/mission.ts` → `project.ts` RENAME+MODIFY; `src/utils/doctor/checks/{assignment,structure,integrations,env,dashboard,workspace,registry}.ts` MODIFY; `src/utils/{github-backup,install,playbooks}.ts` MODIFY |
| Lifecycle | `src/lifecycle/{transitions,index,types,frontmatter}.ts` MODIFY |
| Dashboard backend | `src/dashboard/{api,api-write,parser,types,server,scanner,watcher,autodiscovery,session-db,agent-sessions,api-agent-sessions,api-servers,servers,help}.ts` MODIFY |
| Dashboard frontend | `dashboard/src/App.tsx`, `dashboard/src/hooks/useMissions.ts` → `useProjects.ts`, `dashboard/src/pages/Mission*.tsx` → `Project*.tsx`, `dashboard/src/pages/{AssignmentDetail,AssignmentsPage,CreateAssignment,EditAssignment*,AppendAssignment*,Attention,Overview,AgentSessionsPage,ServersPage,TodosPage,WorkspaceTodosPage,SettingsPage,Help,CreatePlaybook,EditPlaybook,PlaybookDetail,PlaybooksPage}.tsx`, `dashboard/src/lib/{routes,documents,assignments,kanban,types}.ts`, `dashboard/src/types.ts`, `dashboard/src/components/{MarkdownEditor,DocumentEditorPage}.tsx` |
| Hooks + platforms | `platforms/claude-code/hooks/{enforce-boundaries.sh,hooks.json,session-cleanup.sh}`, `platforms/codex/scripts/{enforce-boundaries.sh,session-cleanup.sh}`, `platforms/codex/hooks.json`; all 6 skills × 2 platforms (12 `SKILL.md`); `platforms/claude-code/skills/create-mission/` → `create-project/` RENAME; `platforms/codex/skills/create-mission/` → `create-project/` RENAME; `platforms/claude-code/agents/syntaur-expert.md`; `platforms/codex/agents/syntaur-operator.md`; `platforms/*/references/{protocol-summary,file-ownership}.md`; adapter templates (`platforms/cursor/adapters/syntaur-protocol.mdc`, `platforms/opencode/adapters/opencode.json.template`, `platforms/codex/adapters/AGENTS.md.template`) |
| Protocol docs | `docs/protocol/spec.md` MODIFY (sections 3, 4, 5, 9); `docs/protocol/file-formats.md` MODIFY (add `project.md`, `comments.md`, `progress.md`; remove `agent.md`, `claude.md`; update `assignment.md`, `_status.md`) |
| TUI | `src/tui/*` rename references |
| Tests | `src/__tests__/{templates,adapter-templates,dashboard-parser,dashboard-api,dashboard-write,dashboard-ui-helpers,dashboard-help-contract,commands,lifecycle-commands,cli-default-command,setup-install,setup-adapter,github-backup,agent-sessions,autodiscovery,scanner,paths,doctor,frontmatter,server-tracker}.test.ts` MODIFY; new: `src/__tests__/{comment,request,progress-template,comments-template,resolver,type-field}.test.ts`; DELETE: existing `src/__tests__/assignment-resolver.test.ts` (rewrite as `resolver.test.ts`) |
| Examples | `examples/sample-mission/` → `examples/sample-project/` RENAME; `examples/sample-project/agent.md` DELETE; `examples/sample-project/claude.md` DELETE; rename `mission.md` → `project.md` inside |
| Scripts | `scripts/seed-demo.mjs` MODIFY |
| Deletions | `claude-info/plans/2026-04-11-standalone-assignments-refactor-lite.md` (superseded); existing untracked `src/utils/assignment-resolver.ts` and `src/__tests__/assignment-resolver.test.ts` (replaced by fresh v2 versions) |

## Patterns to Follow

- **Template render function:** pure `renderXxx(params): string` returning markdown + YAML frontmatter. Export via `src/templates/index.ts`. Add test in `templates.test.ts`. Reference: `src/templates/handoff.ts`, `src/templates/decision-record.ts`.
- **Parser function:** `parseXxx(content: string): ParsedXxx` using `extractFrontmatter`, `getField`, `parseListField` from `src/dashboard/parser.ts`. Reference: existing `parseMission`, `parseAssignmentFull` in `src/dashboard/parser.ts`.
- **CLI-mediated append:** read file, increment count field, build entry block with `## Heading` + `**Recorded:** <ts>` + body, replace empty placeholder OR append, update `updated` timestamp via `setTopLevelField`. Reference: `appendLogEntry()` at `src/dashboard/api-write.ts` line 126; handoff/decision-record POST handlers around line 660.
- **Lifecycle command:** validate slug → resolve dir → `executeTransition(projectDir, assignment, action)` OR `executeTransitionByDir(assignmentDir, action, { standalone: true })` for standalone. Reference: `src/commands/complete.ts`.
- **Status rollup:** live computation in `buildProjectRollup`. `openQuestions` = count of `{ type: 'question', resolved: false }` across all assignments' `comments.md` in the project. Reference: existing `buildMissionRollup` at `src/dashboard/api.ts` line 835.
- **Backlink computation:** in `getAssignmentDetail` (renamed), scan all assignments' `todos`, `comments.md`, `progress.md`, `handoff.md` bodies for markdown links resolving to other assignments; reverse-map source → target; return on detail response as `referencedBy: [{ sourceId, sourceSlug, sourceTitle, mentions }]`.
- **Standalone routing:** folder name = UUID. Frontmatter `slug` is display-only. Resolver scans both `projectsDir` and `assignmentsDir`; standalone priority on duplicate.
- **PATCH immutability:** parse submitted content's frontmatter, restore `id` and `project` from existing file via `setTopLevelField`, write corrected content.
- **Dashboard route doubling:** every project-scoped page has both `/projects/:slug/...` and `/w/:workspace/projects/:slug/...` siblings. For standalone: `/assignments/:id/...` and `/w/:workspace/assignments/:id/...`.
- **Platform mirror:** after every claude-code edit, apply equivalent change to codex mirror + adapter templates + adapter-templates test substrings.

---

## Chunk 1 — Rename mission → project (infrastructure only)

Non-destructive, no new features. Every file renamed, every identifier retokenized, every route path swapped. End of chunk: typecheck green, existing tests still green after their own updates (fixtures renamed). Protocol version bumped to 2.0.

### 1.1 Paths, config, templates

- **File:** `src/utils/paths.ts` MODIFY
  - **What:** Rename `defaultMissionDir()` → `defaultProjectDir()`. Change return from `resolve(syntaurRoot(), 'missions')` → `resolve(syntaurRoot(), 'projects')`. Add `assignmentsDir(): string` returning `resolve(syntaurRoot(), 'assignments')`.
  - **Verify:** `npm run typecheck`
- **File:** `src/utils/config.ts` MODIFY
  - **What:** Rename `defaultMissionDir` field on `SyntaurConfig` → `defaultProjectDir`. Rename parse key in `readConfig()` from `fm['defaultMissionDir']` → `fm['defaultProjectDir']`. Update `DEFAULT_CONFIG` to use `defaultProjectDir: defaultProjectDir()`. Bump `DEFAULT_CONFIG.version` from `'1.0'` to `'2.0'`. Update the literal `defaultMissionDir:` in the 4 inline template strings in `writeStatusConfig`, `updateIntegrationConfig`, `updateOnboardingConfig`, `updateBackupConfig` (around lines 337, 414, 446, 480) to `defaultProjectDir:`. Also update fallback string `'missions, playbooks, todos, servers, config'` → `'projects, playbooks, todos, servers, config'` in backup categories default (line 468 and 548).
  - **Verify:** `npm run typecheck`
- **File:** `src/templates/config.ts` MODIFY
  - **What:** Rename `ConfigParams.defaultMissionDir` → `defaultProjectDir`. Update emitted YAML key.
- **File:** `src/templates/mission.ts` RENAME to `src/templates/project.ts`, MODIFY
  - **What:** Rename `renderMission` → `renderProject`, `MissionParams` → `ProjectParams`. Simplify body to "minimal: goal, grouping, metadata" per user spec. Drop `## Notes` subsection if desired; keep `## Overview` with a placeholder for goal + context + success criteria. Frontmatter retains `id`, `slug`, `title`, `archived*`, `created`, `updated`, `externalIds`, `tags`, optional `workspace`.
- **File:** `src/templates/manifest.ts` MODIFY
  - **What:** Change frontmatter `version: "1.0"` → `version: "2.0"`. Change `mission: ${params.slug}` → `project: ${params.slug}`. Change `# Mission: ${params.slug}` → `# Project: ${params.slug}`. Change `[Mission Overview](./mission.md)` → `[Project Overview](./project.md)`. **Delete** the entire `## Config` block (lines 26-29): `[Agent Instructions](./agent.md)` and `[Claude Code Instructions](./claude.md)` are gone — repo-level `CLAUDE.md`/`AGENTS.md` + `~/.syntaur/playbooks/` replace them.
- **File:** `src/templates/index-stubs.ts` MODIFY
  - **What:** In all 6 stub renderers, change frontmatter `mission: ${params.slug}` → `project: ${params.slug}`. In `renderStatus` also change `# Mission Status` → `# Project Status`. (The `unansweredQuestions` → `openQuestions` rename and `agent.md/claude.md` removal are both covered in later chunks: comments in chunk 5, agent/claude removal already happened in manifest.ts above.)
- **File:** `src/templates/agent.ts` DELETE
- **File:** `src/templates/claude.ts` DELETE
- **File:** `src/templates/index.ts` MODIFY
  - **What:** Remove `agent`/`claude` exports. Rename `mission` export to `project`. Update import paths consumers use.
- **File:** `src/templates/codex-agents.ts`, `src/templates/cursor-rules.ts`, `src/templates/opencode-config.ts` MODIFY
  - **What:** Update embedded directory trees from `~/.syntaur/missions/<slug>/` → `~/.syntaur/projects/<slug>/`, file listings to reference `project.md` instead of `mission.md/agent.md/claude.md`, reading-order prose, CLI examples to use `create-project` and `--project` and `syntaur create-assignment ... --project <slug>`.
- **Verify:** `npm run typecheck` green; `npx vitest run src/__tests__/templates.test.ts src/__tests__/adapter-templates.test.ts` green after updating those tests.

### 1.2 CLI rename

- **File:** `src/commands/create-mission.ts` RENAME to `src/commands/create-project.ts`, MODIFY
  - **What:** Rename exported function `createMissionCommand` → `createProjectCommand`. Rename arg parsing: output labels "project" not "mission". Rename all internal `missionDir` → `projectDir`, imports from `./mission.js` → `./project.js`. **Remove** calls to `renderAgent()` and `renderClaude()` and any `agent.md`/`claude.md` writes — the scaffolded directory now only contains `project.md`, `manifest.md`, `_index-*.md`, `_status.md`, `resources/_index.md`, `memories/_index.md`, and the `assignments/` placeholder directory.
- **File:** `src/commands/create-assignment.ts` MODIFY
  - **What:** Rename `--mission <slug>` option to `--project <slug>`. Rename `options.mission` → `options.project`. Rename local `missionDir` → `projectDir`. (The `--type` flag and standalone behavior come in chunks 2 & 3.)
- **Files:** `src/commands/{assign,start,review,complete,block,unblock,fail,reopen}.ts` MODIFY (×8)
  - **What for each:** Rename `--mission` → `--project`, `options.mission` → `options.project`, `missionDir` → `projectDir`. Update help text.
- **Files:** `src/commands/{track-session,setup-adapter,browse,todo}.ts` MODIFY
  - **What:** Same flag + variable rename. For `todo.ts`, the `promote` subcommand's `--mission` → `--project`.
- **File:** `src/commands/init.ts` MODIFY
  - **What:** The dir bootstrap must create `~/.syntaur/projects/` (renamed) and `~/.syntaur/assignments/`. Remove any legacy `~/.syntaur/missions/` logic.
- **File:** `src/commands/dashboard.ts` MODIFY
  - **What:** Rename variable passing to use `projectsDir: defaultProjectDir()` and pass `assignmentsDir: assignmentsDir()` to `createDashboardServer`.
- **File:** `src/index.ts` MODIFY
  - **What:** Rename subcommand registration: `create-mission` → `create-project`. Update every `.option('--mission <slug>', ...)` → `.option('--project <slug>', ...)`. Drop the old `create-mission` subcommand entirely (no alias).
- **Verify:** `npm run typecheck` green. `npx vitest run src/__tests__/commands.test.ts src/__tests__/cli-default-command.test.ts` green after test updates.

### 1.3 Lifecycle + dashboard backend rename

- **Files:** `src/lifecycle/{transitions,index,types,frontmatter}.ts` MODIFY
  - **What:** Variable renames: `missionDir` → `projectDir`, `MISSION_MARKERS` → `PROJECT_MARKERS`. Type `AssignmentFrontmatter` — no structural change yet, just comments/text. (New `project` field arrives implicitly via later work.)
- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** Rename `listMissions` → `listProjects`, `getMissionDetail` → `getProjectDetail`, `buildMissionRollup` → `buildProjectRollup`. Rename `MissionRecord`/`MissionSummary` → `ProjectRecord`/`ProjectSummary`. All internal `missionsDir` → `projectsDir`, `missionSlug` → `projectSlug`, `missionTitle` → `projectTitle`, `missionWorkspace` → `projectWorkspace`. Route path literals: change every instance of `mission` in a response payload key to `project` (e.g., `result.missions` → `result.projects`). Keep `unansweredQuestions` unchanged in this chunk — rename comes in chunk 5.
- **File:** `src/dashboard/api-write.ts` MODIFY
  - **What:** Change route paths from `/api/missions` → `/api/projects`, `/api/missions/:slug` → `/api/projects/:slug`, `/api/missions/:slug/assignments` → `/api/projects/:slug/assignments`, plus every nested path. Update template route `/api/templates/mission` → `/api/templates/project` and call `renderProject`. Variable renames throughout. Update parameter name `missionsDir` → `projectsDir` on `createWriteRouter`.
- **File:** `src/dashboard/parser.ts` MODIFY
  - **What:** Rename `parseMission` → `parseProject`, `ParsedMission` → `ParsedProject`. Change the `slug`/`title`/etc. extraction to continue reading the same frontmatter (project.md has same schema as old mission.md).
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** Rename `MissionBoardItem` → `ProjectBoardItem`, `MissionDetail` → `ProjectDetail`, and every other `Mission*` type. Field renames: `missionSlug` → `projectSlug`, `missionTitle` → `projectTitle`, `missionWorkspace` → `projectWorkspace`. `TrackedPane.assignment.mission` → `TrackedPane.assignment.project`.
- **Files:** `src/dashboard/{server,scanner,watcher,autodiscovery,session-db,agent-sessions,api-agent-sessions,api-servers,servers,help}.ts` MODIFY
  - **What:** All `missionsDir` → `projectsDir` in function signatures, variables, route paths, help catalog entries, SQL WHERE clauses. Watcher event name `mission-updated` → `project-updated`. Session DB column `mission_slug` — keep the SQL column name unchanged (migration-free; only the identifier in JS code referring to it is renamed to `projectSlug` where used).

Note on SQLite column name: renaming the SQL column requires a migration. Per the user's "no migration needed" directive and because Syntaur has no users, we still must ensure the schema-creation DDL in `session-db.ts` emits the `project_slug` column name going forward. **Decision: rename the SQL column to `project_slug`.** Since there are no deployed DBs, the table gets (re)created fresh on first start. Update:
  - `CREATE TABLE ...` DDL: `mission_slug` → `project_slug`
  - Every `INSERT`/`SELECT`/`UPDATE`/`WHERE` referencing `mission_slug` → `project_slug`
  - Every TS binding column reference in `better-sqlite3` queries

- **Verify:** `npm run typecheck` green. `npx vitest run src/__tests__/dashboard-parser.test.ts src/__tests__/dashboard-api.test.ts src/__tests__/dashboard-write.test.ts src/__tests__/agent-sessions.test.ts src/__tests__/scanner.test.ts src/__tests__/autodiscovery.test.ts src/__tests__/server-tracker.test.ts` green after test updates.

### 1.4 Dashboard frontend rename

- **File:** `dashboard/src/App.tsx` MODIFY
  - **What:** Rename routes `/missions` → `/projects`, `/missions/:slug` → `/projects/:slug`, every nested mission route. Rename component imports.
- **Files:** `dashboard/src/pages/{MissionDetail,MissionList,CreateMission,EditMission}.tsx` RENAME → `{ProjectDetail,ProjectList,CreateProject,EditProject}.tsx`, MODIFY
  - **What:** Component name rename, URL construction using `/projects/` prefix, label text "Mission" → "Project".
- **Files:** `dashboard/src/pages/{AssignmentDetail,AssignmentsPage,CreateAssignment,EditAssignment,EditAssignmentPlan,EditAssignmentScratchpad,AppendAssignmentHandoff,AppendAssignmentDecisionRecord,Attention,Overview,AgentSessionsPage,ServersPage,TodosPage,WorkspaceTodosPage,SettingsPage,Help,CreatePlaybook,EditPlaybook,PlaybookDetail,PlaybooksPage}.tsx` MODIFY
  - **What:** Variable/prop rename mission* → project*. URL construction swap. Label text swap. Breadcrumb labels.
- **File:** `dashboard/src/hooks/useMissions.ts` RENAME → `useProjects.ts`, MODIFY
  - **What:** Rename hooks: `useMissions` → `useProjects`, `useMission` → `useProject`, `useMissionDetail` → `useProjectDetail`. URL paths under `/api/missions/` → `/api/projects/`. Type renames `MissionBoardItem` → `ProjectBoardItem`, etc., in the frontend-mirror interfaces. WS event listener name `mission-updated` → `project-updated`.
- **Files:** `dashboard/src/lib/{routes,documents,assignments,kanban,types}.ts` MODIFY
  - **What:** All route helpers, breadcrumb builders, API URL builders, document-URL builders swap to project paths. `buildShellMeta` in `routes.ts`: update the `parts[0] === 'missions'` block to `parts[0] === 'projects'`.
- **File:** `dashboard/src/types.ts` MODIFY
  - **What:** `TrackedPane.assignment.mission` field → `project`. Other frontend-mirror interfaces rename.
- **Files:** `dashboard/src/components/{MarkdownEditor,DocumentEditorPage}.tsx` MODIFY
  - **What:** Any `missionSlug` prop → `projectSlug`. Label/placeholder text swap.
- **Verify:** `cd dashboard && npx tsc -b --noEmit` green. Manual smoke: `cd dashboard && npm run build`.

### 1.5 Platforms + protocol docs

- **Files:** `platforms/claude-code/hooks/{enforce-boundaries.sh,hooks.json,session-cleanup.sh}` MODIFY
  - **What:** Path literals `~/.syntaur/missions/` → `~/.syntaur/projects/`. Label "mission" → "project". `bash -n` validation.
- **Files:** `platforms/codex/scripts/{enforce-boundaries.sh,session-cleanup.sh}`, `platforms/codex/hooks.json` MODIFY
  - **What:** Exact mirror of claude-code changes. `bash -n` validation.
- **Directory:** `platforms/claude-code/skills/create-mission/` RENAME to `create-project/`; content: `SKILL.md` MODIFY — rename command name, all internal "mission" → "project", file-creation list drops `agent.md`/`claude.md`, keeps `project.md` (was `mission.md`).
- **Directory:** `platforms/codex/skills/create-mission/` RENAME to `create-project/`; content: `SKILL.md` MODIFY with identical changes.
- **Files:** `platforms/claude-code/skills/{create-assignment,grab-assignment,plan-assignment,complete-assignment,syntaur-protocol}/SKILL.md` MODIFY, plus codex mirrors.
  - **What:** All `--mission` → `--project`, "mission" → "project", path `~/.syntaur/missions/` → `~/.syntaur/projects/`. File references `mission.md`/`agent.md`/`claude.md` → `project.md` (agent/claude removed entirely).
- **Files:** `platforms/claude-code/agents/syntaur-expert.md`, `platforms/codex/agents/syntaur-operator.md` MODIFY
  - **What:** Body text rename. Same substitution as skills.
- **Files:** `platforms/claude-code/references/{protocol-summary,file-ownership}.md`, `platforms/codex/references/{protocol-summary,file-ownership}.md` MODIFY
  - **What:** Directory tree, field names, CLI examples.
- **Files:** `platforms/cursor/adapters/syntaur-protocol.mdc`, `platforms/opencode/adapters/opencode.json.template`, `platforms/codex/adapters/AGENTS.md.template` MODIFY
  - **What:** All text, file lists, command references swap.
- **File:** `src/__tests__/adapter-templates.test.ts` MODIFY
  - **What:** Update every asserted substring. Every `missions` → `projects`, `--mission` → `--project`, `mission.md` → `project.md`, `Mission` → `Project`. Add assertions checking that `agent.md` and `claude.md` are NOT referenced.
- **Files:** `docs/protocol/spec.md`, `docs/protocol/file-formats.md` MODIFY
  - **What:** Bump protocol version to 2.0. Rewrite directory structure section (spec.md Section 3 or wherever the tree lives) to show `~/.syntaur/projects/<slug>/` and include `~/.syntaur/assignments/<uuid>/` (full standalone coverage expands in chunk 2 but the tree mention is here). Delete `agent.md`/`claude.md` sections in file-formats.md. Rename `mission.md` section to `project.md` with simplified schema (goal, grouping, metadata). Rename frontmatter field `mission:` → `project:` in manifest section. Leave `comments.md`/`progress.md`/`type` field additions for their own chunks — this chunk is only the rename.
- **Files:** `src/tui/*` MODIFY
  - **What:** Rename every `mission` → `project` reference in variables, prompts, status text.
- **Verify:** `bash -n platforms/claude-code/hooks/enforce-boundaries.sh platforms/claude-code/hooks/session-cleanup.sh platforms/codex/scripts/enforce-boundaries.sh platforms/codex/scripts/session-cleanup.sh`. `npx vitest run src/__tests__/adapter-templates.test.ts` green.

### 1.6 Examples, scripts, tests, scaffolding cleanup

- **Directory:** `examples/sample-mission/` RENAME to `examples/sample-project/`; DELETE `examples/sample-project/agent.md`, `examples/sample-project/claude.md`; RENAME `examples/sample-project/mission.md` → `project.md`; update its frontmatter + body content.
- **File:** `scripts/seed-demo.mjs` MODIFY
  - **What:** Swap `~/.syntaur/missions/` → `~/.syntaur/projects/`. Rename commands. Drop agent/claude writes.
- **File:** `src/utils/doctor/checks/mission.ts` RENAME to `project.ts`, MODIFY
  - **What:** Rename `REQUIRED_MISSION_FILES` → `REQUIRED_PROJECT_FILES`. Set it to `['project.md', 'manifest.md', '_index-assignments.md', '_index-plans.md', '_index-decisions.md', '_status.md']` — drop `agent.md`, `claude.md`, `mission.md`. Rename `MISSION_MARKERS` → `PROJECT_MARKERS`. All internal "mission" → "project".
- **Files:** `src/utils/doctor/checks/{assignment,structure,integrations,env,dashboard,workspace,registry}.ts` MODIFY
  - **What:** Variable + path renames. For `assignment.ts`, already gets a new `project` frontmatter check in chunk 2.
- **Files:** `src/utils/{github-backup,install,playbooks}.ts` MODIFY
  - **What:** Any `missions` path/variable → `projects`.
- **Files:** ALL `src/__tests__/*.test.ts` EXCEPT `adapter-templates.test.ts` (already covered): MODIFY
  - **What:** Fixture content rename. Any test creating a `~/.syntaur/missions/foo/` tmp dir → `~/.syntaur/projects/foo/`. Any `--mission` CLI arg → `--project`. Any `mission.md` fixture file → `project.md`. Rename test describe/it labels. Delete any fixture `agent.md`/`claude.md` creations.
- **File:** `package.json` MODIFY
  - **What:** Update the `description` field from "Mission workflow CLI..." to "Project workflow CLI with dashboard, Claude Code plugin, and Codex plugin". (Version bump waits until final chunk.)
- **Delete plan input files (at end of chunk 1):**
  - `claude-info/plans/2026-04-11-standalone-assignments-refactor-lite.md` — superseded
  - `src/utils/assignment-resolver.ts` — will be rebuilt fresh under v2 names in chunk 2
  - `src/__tests__/assignment-resolver.test.ts` — will be rebuilt fresh in chunk 2

### 1.7 Chunk 1 verification

- `npm run typecheck` green
- `cd dashboard && npx tsc -b --noEmit` green
- `npx vitest run` all green
- `bash -n` on all 4 hook scripts
- `Grep pattern="[Mm]ission" path="src"` returns 0 matches
- `Grep pattern="[Mm]ission" path="dashboard/src"` returns 0 matches
- `Grep pattern="[Mm]ission" path="platforms"` returns 0 matches
- `Grep pattern="[Mm]ission" path="docs"` returns 0 matches
- Manual smoke: `node dist/index.js init` creates `~/.syntaur/projects/` and `~/.syntaur/assignments/`. `node dist/index.js create-project "Test" --slug test` scaffolds correctly with no agent.md/claude.md, with `project.md` present. `node dist/index.js dashboard` boots; navigate to `/projects`; old `/missions` route returns 404.
- **Commit:** `chore(protocol): rename mission → project and bump protocol to v2.0`

---

## Chunk 2 — Standalone assignments

Assignments live at `~/.syntaur/assignments/<uuid>/` with no project parent. Folder = UUID; `slug` is display-only. `project: null` in frontmatter. Dashboard routes UUID-based. `dependsOn` rejected. Browse/TUI out of scope.

### 2.1 Resolver + utilities

- **File:** `src/utils/assignment-resolver.ts` CREATE (fresh rewrite)
  - **What:** Export `ResolvedAssignment = { assignmentDir: string; projectSlug: string | null; assignmentSlug: string; id: string; standalone: boolean }`. Export `resolveAssignmentById(projectsDir: string, assignmentsDir: string, id: string): Promise<ResolvedAssignment | null>`. Algorithm:
    1. Check `resolve(assignmentsDir, id, 'assignment.md')` — if exists: standalone match
    2. Scan `projectsDir/*/assignments/*/assignment.md`, parse frontmatter, match on `id` field: project-nested match
    3. If both match (rare collision): log `console.warn('Duplicate assignment ID ${id} in both standalone and project-nested')`, return standalone
    4. Return match or `null`
  - **Pattern:** Follow `src/dashboard/parser.ts` `extractFrontmatter` + `getField` usage.
- **File:** `src/__tests__/resolver.test.ts` CREATE
  - **What:** 4 cases: standalone found, project-nested found (via frontmatter id scan), not found, duplicate collision (returns standalone + warns).
- **Verify:** `npx vitest run src/__tests__/resolver.test.ts` green.

### 2.2 Data model: add `project` frontmatter field

- **File:** `src/lifecycle/types.ts` MODIFY
  - **What:** Add `project: string | null` to `AssignmentFrontmatter`. Add `type?: string` (placeholder — populated in chunk 3).
- **File:** `src/lifecycle/frontmatter.ts` MODIFY
  - **What:** In `parseAssignmentFrontmatter()`, add `project: getField('project') ?? null` to the returned object (treating `'null'` string as null).
- **File:** `src/templates/assignment.ts` MODIFY
  - **What:** Add `project?: string | null` to `AssignmentParams`. Render `project: <value>` in frontmatter after `slug` (emit literal `null` when null/undefined). **Remove** `## Questions & Answers` and `## Progress` body sections — chunks 4 and 5 replace them with separate files; this chunk prepares the template to be clean.

  Note: clean-up of `## Questions & Answers` and `## Progress` sections happens in chunks 4 and 5 respectively, not here. Chunk 2 only adds `project` + placeholder `type` to the frontmatter. Leave body sections intact for now to keep this chunk small.

  Correction: per commit-chunking plan, chunks 4 and 5 remove those sections. So in chunk 2, leave them. Keeping this note for clarity.

- **File:** `src/dashboard/parser.ts` MODIFY
  - **What:** Add `project: string | null` to `ParsedAssignmentFull`. Extract `getField(fm, 'project')` with `null` when missing or literal `'null'`. Determine standalone vs project-nested from directory context, not this field.
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** Change `projectSlug: string` → `projectSlug: string | null` on `AssignmentBoardItem`, `AssignmentDetail`, `AttentionItem`, `RecentActivityItem`, `EditableDocumentResponse`. Same for `projectTitle: string` → `string | null`. `TrackedPane.assignment.project` is already `string | null` after chunk 1 rename, but re-audit.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY
  - **What:** Mirror the nullability on all frontend interface duplicates.
- **File:** `dashboard/src/types.ts` MODIFY
  - **What:** `TrackedPane.assignment` type becomes `{ project: string | null; slug: string; title: string } | null`.
- **Verify:** `npm run typecheck` reveals every null-handling site. `cd dashboard && npx tsc -b --noEmit`. Add tests to `frontmatter.test.ts` and `dashboard-parser.test.ts` for new `project` field (missing → null, explicit null → null, real slug → slug).

### 2.3 Lifecycle: add `executeTransitionByDir` + `executeAssignByDir`

- **File:** `src/lifecycle/transitions.ts` MODIFY
  - **What:** Factor path-resolution out of `executeTransition`. Add `executeTransitionByDir(assignmentDir: string, action: string, options?: TransitionOptions & { standalone?: boolean })`:
    1. Read `resolve(assignmentDir, 'assignment.md')`
    2. Parse frontmatter
    3. Skip `checkDependencies()` when `options.standalone === true`
    4. Run state machine and write back
  - Keep `executeTransition(projectDir, slug, action, ...)` as a thin wrapper that resolves `assignmentDir = resolve(projectDir, 'assignments', slug)` then delegates.
  - Add `executeAssignByDir(assignmentDir: string, agent: string)` likewise.
- **File:** `src/lifecycle/index.ts` MODIFY
  - **What:** Export both new functions.
- **File:** `src/__tests__/lifecycle-commands.test.ts` MODIFY
  - **What:** Add: `executeTransitionByDir` works on standalone path; skips dependency checks with `standalone: true`; existing `executeTransition` still works.
- **Verify:** `npx vitest run src/__tests__/lifecycle-commands.test.ts` green.

### 2.4 CLI: create-assignment `--one-off`, lifecycle by UUID

- **File:** `src/commands/create-assignment.ts` MODIFY
  - **What:** When `--one-off` flag is present:
    1. Generate UUID via `generateId()`
    2. Path: `resolve(assignmentsDir(), uuid)`
    3. Write standard assignment files (`assignment.md`, `plan.md`, `scratchpad.md`, `handoff.md`, `decision-record.md`)
    4. Pass `project: null` to `renderAssignment()`
    5. Do NOT call `createProjectCommand()`
    6. Reject `--depends-on` with error: "Standalone assignments cannot have dependencies"
    7. Output: `Created standalone assignment at ~/.syntaur/assignments/<uuid>/`
  - Also in project-nested path: pass `project: options.project` to `renderAssignment()`.
  - `--dir` help: document it is ignored for `--one-off`.
- **Files:** `src/commands/{start,complete,block,unblock,review,fail,reopen,assign}.ts` MODIFY (×8)
  - **What for each:** Make `--project` optional. When omitted: treat `assignment` positional arg as UUID, call `resolveAssignmentById(projectsDir, assignmentsDir, assignment)`, 404 via thrown Error if null, invoke `executeTransitionByDir(resolved.assignmentDir, action, { standalone: resolved.standalone })` (or `executeAssignByDir` for `assign.ts`). Skip slug validation (`isValidSlug`) in ID mode.
- **File:** `src/commands/todo.ts` MODIFY
  - **What:** `promote` subcommand `--project` becomes optional. When omitted, print hint: `Run: syntaur create-assignment --one-off "<description>"`.
- **File:** `src/index.ts` MODIFY
  - **What:** Update help text on `--project` options across lifecycle commands: `'Project slug (omit for standalone assignment by UUID)'`. Remove `.requiredOption` in favor of `.option`. Update `track-session --assignment` help to note it accepts slug (with `--project`) or UUID.
- **File:** `src/__tests__/commands.test.ts` MODIFY
  - **What:** `--one-off` test verifies assignment created at `assignmentsDir/<uuid>/`, folder name = frontmatter `id`, `project: null` in frontmatter, `slug` is human-readable. `--one-off --depends-on foo` returns error.
- **Verify:** `npx vitest run src/__tests__/commands.test.ts src/__tests__/lifecycle-commands.test.ts` green. Manual: `node dist/index.js init && node dist/index.js create-assignment "Test" --one-off && node dist/index.js start <uuid>`.

### 2.5 Dashboard backend: standalone routes + scanner/watcher

- **File:** `src/dashboard/server.ts` MODIFY
  - **What:** Add `assignmentsDir: string` to `DashboardServerOptions`. Pass to write router, api, scanner, watcher, agent-sessions router, servers router.
- **File:** `src/dashboard/api.ts` MODIFY
  - **What:**
    - `listAssignmentsBoard(projectsDir, assignmentsDir)` — after collecting project-nested, scan `assignmentsDir/*` for standalone. Set `projectSlug: null`, `projectTitle: null`, `projectWorkspace: null`.
    - Extract `buildAssignmentDetail(assignmentDir, projectSlug, projectsDir)` helper from `getAssignmentDetail`. Add `getAssignmentDetailById(projectsDir, assignmentsDir, id)` that resolves via resolver then delegates.
    - `getEditableDocument` — add `getEditableDocumentById(projectsDir, assignmentsDir, documentType, id)` variant.
    - `getDocumentPath` — split to accept `assignmentDir` directly for assignment-level docs; keep `project` doc path unchanged.
    - `getAvailableTransitions` — accept `assignmentDir` directly; skip dependency checks for standalone.
    - `getUnmetDependencies` — return `[]` when `projectSlug === null`.
    - `getOverview` — accept `assignmentsDir`; include standalone in `stats`; `firstRun` false if standalone count > 0 even when projects = 0.
    - `buildAttentionItems` — accept standalone list; `href: /assignments/<id>`, `projectSlug: null`, `projectTitle: null`.
    - `buildRecentActivity` — same pattern.
- **File:** `src/dashboard/api-write.ts` MODIFY
  - **What:** Accept `assignmentsDir` in `createWriteRouter(projectsDir, assignmentsDir)`. Extract per-route handlers into shared helpers taking `(assignmentDir, projectSlug, assignmentIdentifier, body)` pattern. Add:
    - `POST /api/assignments` — create standalone. Validate `dependsOn` empty → else 400 "Standalone assignments cannot have dependencies". Write to `assignmentsDir/<uuid>/`.
    - `GET /api/assignments/:id/edit` — resolve by ID, return editable doc.
    - `PATCH /api/assignments/:id` — immutability: parse submitted content frontmatter, restore `id` and `project` from existing file via `setTopLevelField`. Reject `dependsOn` non-empty → 400.
    - `PATCH /api/assignments/:id/plan`, `/scratchpad` — update.
    - `POST /api/assignments/:id/handoff/entries`, `/decision-record/entries` — append.
    - `POST /api/assignments/:id/transitions/:command` — call `executeTransitionByDir`.
    - `POST /api/assignments/:id/status-override` — override.
    - `PATCH /api/assignments/:id/acceptance-criteria/:index` — update criterion.
  - Update companion-doc PATCH validators to compare `next.assignment` against UUID for standalone, slug for project-nested.
  - `POST /api/projects/:slug/assignments` — project-nested handler now also calls `setTopLevelField(content, 'project', projectSlug)` before write to ensure the field is populated.
  - Duplicate-UUID prevention: every create path calls `resolveAssignmentById` before writing. On collision, regenerate UUID (up to 3 attempts), overwrite `id` in markdown via `setTopLevelField`.
- **File:** `src/dashboard/scanner.ts` MODIFY
  - **What:** `loadWorkspaceRecords(projectsDir, assignmentsDir)` — after scanning projects, scan `assignmentsDir/*` for standalone. Records carry `projectSlug: null`. `autoLinkPane` — match standalone by workspace path/branch. When matched, `pane.assignment = { project: null, slug: <uuid>, title }`. Update all callers in `scanner.ts`, `autodiscovery.ts`, `api.ts`, `api-servers.ts` to pass `assignmentsDir`.
- **File:** `src/dashboard/watcher.ts` MODIFY
  - **What:** Add `assignmentsDir?: string` to `WatcherOptions`. If provided AND `existsSync(assignmentsDir)`, create watcher. Debounce + broadcast `assignment-updated` WS message with `projectSlug: undefined` (or null) for standalone changes.
- **File:** `src/dashboard/agent-sessions.ts` MODIFY
  - **What:** `reconcileActiveSessions` — drop `project_slug IS NOT NULL` filter. When `project_slug IS NULL`, resolve path as `resolve(assignmentsDir, assignment_slug)`. Accept `assignmentsDir` in signature. Add `readAssignmentStatus(assignmentDir)` helper. Add `listSessionsByAssignment(resolved: ResolvedAssignment)` — SQL branches on `standalone`.
- **File:** `src/dashboard/api-agent-sessions.ts` MODIFY
  - **What:** Router accepts `assignmentsDir`. Pass to `reconcileActiveSessions` at both call sites. Add `GET /api/assignments/:id/sessions` route (as standalone route in `server.ts`, not inside agent-sessions router) using `resolveAssignmentById` + `listSessionsByAssignment`.
- **File:** `src/dashboard/api-servers.ts` MODIFY
  - **What:** Manual pane link override route accepts `body.project: string | null`. Pass `assignmentsDir` through to scanner.
- **File:** `src/dashboard/servers.ts` MODIFY
  - **What:** `BuildSessionOptions.overrides` entry `{ project: string | null; assignment: string }`. `buildSessionContent` emits `project: null` when null. `readSessionFile` regex matches `project: null` (unquoted) and `project: "..."`. `setOverride` nullable.
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** `SessionFileData.overrides` mirrors `BuildSessionOptions.overrides`.
- **File:** `src/dashboard/autodiscovery.ts` MODIFY
  - **What:** `discoverTmuxSessions` and `discoverProcesses` accept + pass `assignmentsDir`.
- **File:** `src/commands/track-session.ts` MODIFY
  - **What:** Output adjusted for standalone sessions. Optional `resolveAssignmentById` validation (warn but don't block).
- **Verify:** `npm run typecheck`. `npx vitest run src/__tests__/dashboard-api.test.ts src/__tests__/dashboard-write.test.ts src/__tests__/scanner.test.ts src/__tests__/autodiscovery.test.ts src/__tests__/agent-sessions.test.ts src/__tests__/server-tracker.test.ts` after test updates.

### 2.6 Dashboard frontend: standalone pages

- **File:** `dashboard/src/App.tsx` MODIFY
  - **What:** Add routes: `/assignments/:id`, `/assignments/:id/edit`, `/assignments/:id/plan/edit`, `/assignments/:id/scratchpad/edit`, `/assignments/:id/handoff/edit`, `/assignments/:id/decision-record/edit`. Duplicate all under `/w/:workspace/assignments/:id/...`.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY
  - **What:** Add `useAssignmentById(id)`, `useAssignmentSessionsById(id)`. Pattern follows existing `useAssignment`.
- **File:** `dashboard/src/lib/assignments.ts` MODIFY
  - **What:** Add `runAssignmentTransitionById(id, action, reason?)` and `overrideAssignmentStatusById(id, status)`.
- **File:** `dashboard/src/lib/routes.ts` MODIFY
  - **What:** `buildShellMeta` handles `/assignments/:id/...` path. Breadcrumbs: `Assignments > <TitleCase(uuid)>`. `projectSlug: null`.
- **Files:** `dashboard/src/pages/{AssignmentDetail,AssignmentsPage,EditAssignment,EditAssignmentPlan,EditAssignmentScratchpad,AppendAssignmentHandoff,AppendAssignmentDecisionRecord,AgentSessionsPage,ServersPage}.tsx` MODIFY
  - **What:** `useParams` accepts `{ slug?, aslug?, id? }`. When `id` present: standalone URLs + hooks; when `slug`/`aslug`: project-nested. `AssignmentsPage`: filter dropdown adds "Standalone" option; cards show "Standalone" when `projectTitle` null. `AgentSessionsPage`: when `!projectSlug && assignmentSlug`, link to `/assignments/<slug>`. `ServersPage`: pane link to `/assignments/<slug>` when `pane.assignment.project === null`; include standalone in filter buckets.
- **Files:** `dashboard/src/components/{MarkdownEditor,DocumentEditorPage}.tsx` MODIFY
  - **What:** `MarkdownEditor` accepts `projectSlug?: string | null`. When null, hide "Depends on" field. `DocumentEditorPage` passes `data.projectSlug` to `MarkdownEditor`.
- **Verify:** `cd dashboard && npx tsc -b --noEmit && npm run build` green. Manual: navigate to `/assignments/<uuid>`, edit, transition.

### 2.7 Docs + init

- **File:** `src/commands/init.ts` MODIFY
  - **What:** Already ensured `~/.syntaur/projects/` in chunk 1. Now also `await ensureDir(assignmentsDir())`. Console-log the created path.
- **File:** `docs/protocol/spec.md` MODIFY
  - **What:** Document `~/.syntaur/assignments/<uuid>/`. Note folder name is UUID, `slug` is display-only. Note `dependsOn` invalid for standalone. Note `project: null` in frontmatter distinguishes standalone, and that the authoritative signal is directory location, not frontmatter field.
- **File:** `docs/protocol/file-formats.md` MODIFY
  - **What:** Add `project` frontmatter field row on the assignment table (`project | string or null | Parent project slug or null for standalone | required | — | —`). Note that standalone folder is UUID, project-nested folder is slug. Note `dependsOn` rejected for standalone.
- **Verify:** Manual read. `Grep pattern="assignments/<" path="docs/protocol"` finds the tree node.

### 2.8 Chunk 2 verification

- `npm run typecheck` green
- `cd dashboard && npx tsc -b --noEmit` green
- `npx vitest run` green
- Manual: `syntaur init && syntaur create-assignment "Demo" --one-off && syntaur start <uuid> && syntaur complete <uuid>`. Dashboard: `/assignments` shows the standalone; `/assignments/<uuid>` loads; transitions work.
- **Commit:** `feat(assignments): add standalone assignments at ~/.syntaur/assignments/<uuid>/`

---

## Chunk 3 — `type` field on assignments

Configurable enum, frontmatter field, filter UI, doctor check.

### 3.1 Config + template

- **File:** `src/utils/config.ts` MODIFY
  - **What:** Add `types: { definitions: { id: string; label: string; description?: string; color?: string; icon?: string }[]; default: string } | null` to `SyntaurConfig`. Parse from config.md frontmatter `types:` block. Serialize via parallel to `serializeStatusConfig` (`serializeTypesConfig`). Provide defaults when null: `[feature, bug, refactor, research, chore]` with `default: 'feature'`.
  - Export `writeTypesConfig`, `deleteTypesConfig` parallel to status equivalents.
- **File:** `src/templates/assignment.ts` MODIFY
  - **What:** Add `type?: string` to `AssignmentParams`. Render `type: <value>` in frontmatter after `project`. Default to config default if not provided.
- **File:** `src/lifecycle/types.ts` MODIFY
  - **What:** `AssignmentFrontmatter.type: string | null`.
- **File:** `src/lifecycle/frontmatter.ts` MODIFY
  - **What:** Parse `type` field.
- **File:** `src/dashboard/parser.ts` MODIFY
  - **What:** `ParsedAssignmentFull.type: string | null`. Extract in `parseAssignmentFull`.
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** Add `type: string | null` to `AssignmentBoardItem` and `AssignmentDetail`.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY
  - **What:** Mirror `type` field on frontend interfaces.

### 3.2 CLI + creation paths

- **File:** `src/commands/create-assignment.ts` MODIFY
  - **What:** Add `--type <type>` option. Validate against `config.types.definitions` or defaults; 400 on mismatch. Pass to `renderAssignment`. Default to config default.
- **File:** `src/dashboard/api-write.ts` MODIFY
  - **What:** Create routes (`POST /api/projects/:slug/assignments`, `POST /api/assignments`) accept `type` in body; validate; render with value or default.

### 3.3 Dashboard UI

- **File:** `dashboard/src/pages/AssignmentsPage.tsx` MODIFY
  - **What:** Add "Type" filter dropdown next to existing status filter. Render type chip on each card.
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` MODIFY
  - **What:** Show type chip in header.
- **File:** `dashboard/src/pages/CreateAssignment.tsx` MODIFY
  - **What:** Add type select (fetched from `/api/types` or inlined from a new `useTypesConfig` hook). Default-select config default.
- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** Add `GET /api/types` endpoint returning parsed config.types definitions + default (or baked-in defaults).

### 3.4 Doctor + docs + tests

- **File:** `src/utils/doctor/checks/assignment.ts` MODIFY
  - **What:** Add optional check: if `config.types` defines definitions, warn when an assignment's `type` is not in the definition set.
- **File:** `docs/protocol/file-formats.md` MODIFY
  - **What:** Add `type | string | Assignment type from config or defaults | optional | config default | — ` row. List default types.
- **File:** `src/__tests__/type-field.test.ts` CREATE
  - **What:** Template renders with `type: feature`. Parser extracts. CLI `--type bug` round-trips. Invalid type rejected. Config override picks up.
- **File:** `src/__tests__/templates.test.ts` MODIFY
- **File:** `src/__tests__/frontmatter.test.ts` MODIFY
- **File:** `src/__tests__/dashboard-parser.test.ts` MODIFY
- **File:** `src/__tests__/dashboard-api.test.ts` MODIFY — `/api/types` endpoint.
- **File:** `src/__tests__/commands.test.ts` MODIFY — `--type` flag.

### 3.5 Platforms

- **Files:** `platforms/claude-code/skills/create-assignment/SKILL.md`, `platforms/codex/skills/create-assignment/SKILL.md` MODIFY
  - **What:** Document `--type` flag.
- **Files:** `src/templates/{codex-agents,cursor-rules,opencode-config}.ts` MODIFY
  - **What:** Mention `type` field in assignment schema description.
- **File:** `src/__tests__/adapter-templates.test.ts` MODIFY — add substring asserts.

### 3.6 Chunk 3 verification

- `npm run typecheck`, `cd dashboard && npx tsc -b --noEmit`, `npx vitest run`
- Manual: `syntaur create-assignment "Bug fix" --one-off --type bug`, `curl /api/types`, dashboard Create Assignment picker, filter works.
- **Commit:** `feat(assignments): add configurable type field (feature/bug/refactor/research/chore)`

---

## Chunk 4 — Progress to separate file (`progress.md`)

Agent-owned, no CLI mediation. Append-only, reverse-chronological.

### 4.1 Template + parser

- **File:** `src/templates/progress.ts` CREATE
  - **What:** Export `ProgressParams = { assignment: string; timestamp: string }`. Export `renderProgress(params): string` returning:
    ```
    ---
    assignment: <value>
    entryCount: 0
    generated: "<ts>"
    updated: "<ts>"
    ---

    # Progress

    No progress yet.
    ```
  - Export `formatProgressEntry(body, timestamp)` → `## <timestamp>\n\n<body>\n` — agents use this format when appending.
- **File:** `src/templates/index.ts` MODIFY — export.
- **File:** `src/dashboard/parser.ts` MODIFY
  - **What:** Add `parseProgress(content) → { entries: { timestamp: string; body: string }[]; entryCount: number; updated: string }`. Split on `## ` headings; parse timestamp + body.

### 4.2 Assignment template cleanup

- **File:** `src/templates/assignment.ts` MODIFY
  - **What:** Remove `## Progress\n\nNo progress yet.` section from body. Add `[Progress](./progress.md)` to the `## Links` section.
- **File:** `src/commands/create-assignment.ts` MODIFY
  - **What:** Alongside the other companion files, write `progress.md` via `renderProgress`.
- **File:** `src/dashboard/api-write.ts` MODIFY
  - **What:** Standalone create route also writes `progress.md`. Project-nested `POST /api/projects/:slug/assignments` — same.

### 4.3 Dashboard surface

- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** `buildAssignmentDetail` reads `progress.md` if present; attaches `progress: { entries, entryCount, updated }` to `AssignmentDetail`. Null if file absent.
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** Add `AssignmentProgress` type + field on `AssignmentDetail`.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY — mirror types.
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` MODIFY
  - **What:** Add Progress tab. Render entries reverse-chronological (newest first). Show `entryCount` badge.

### 4.4 Skill text

- **Files:** `platforms/claude-code/skills/{plan-assignment,complete-assignment}/SKILL.md`, `platforms/codex/skills/{plan-assignment,complete-assignment}/SKILL.md` MODIFY
  - **What:** Instruct agent to append to `progress.md` (prepend newest at top, or append chronological; pick one — **decision: newest at top** per user spec "reverse-chronological"). Provide format block. Note single-writer: agent writes directly to own assignment's `progress.md`. Remove any legacy "update `## Progress` in assignment.md" wording.
- **Files:** `platforms/claude-code/references/{protocol-summary,file-ownership}.md`, codex mirrors MODIFY
  - **What:** Add `progress.md` row to file-ownership matrix: owner = assignment owner agent; readers = all; CLI-mediated = no.
- **Files:** `src/templates/{codex-agents,cursor-rules,opencode-config}.ts` MODIFY — mention `progress.md`.
- **File:** `src/__tests__/adapter-templates.test.ts` MODIFY — assert substrings.

### 4.5 Docs + tests

- **File:** `docs/protocol/file-formats.md` MODIFY
  - **What:** Add `progress.md` section. Document frontmatter (`assignment`, `entryCount`, `generated`, `updated`), body format (reverse-chronological `## <timestamp>\n\n<body>`), owner = agent, no CLI mediation.
- **File:** `src/__tests__/progress-template.test.ts` CREATE — renderProgress, formatProgressEntry, parseProgress round-trip.
- **File:** `src/__tests__/dashboard-parser.test.ts` MODIFY — parseProgress cases.
- **File:** `src/__tests__/dashboard-api.test.ts` MODIFY — AssignmentDetail includes progress.
- **File:** `src/__tests__/templates.test.ts` MODIFY — assignment body no longer has `## Progress`.

### 4.6 Chunk 4 verification

- `npm run typecheck`, `cd dashboard && npx tsc -b --noEmit`, `npx vitest run`
- Manual: create assignment → `progress.md` exists. Hand-append entry → dashboard Progress tab displays it reverse-chron.
- **Commit:** `feat(assignments): split progress into separate progress.md file`

---

## Chunk 5 — Comments replace Q&A

CLI-mediated via new `syntaur comment`. Removes `## Questions & Answers` from assignment template. `openQuestions` replaces `unansweredQuestions`. Dashboard Comments tab.

### 5.1 Template + parser

- **File:** `src/templates/comments.ts` CREATE
  - **What:** Export `CommentsParams = { assignment: string; timestamp: string }`. Export `renderComments(params): string`:
    ```
    ---
    assignment: <value>
    entryCount: 0
    generated: "<ts>"
    updated: "<ts>"
    ---

    # Comments

    No comments yet.
    ```
  - Export `Comment = { id: string; timestamp: string; author: string; type: 'question' | 'note' | 'feedback'; body: string; replyTo?: string; resolved?: boolean }`.
  - Export `formatCommentEntry(comment): string` producing:
    ```
    ## <id>
    
    **Recorded:** <timestamp>
    **Author:** <author>
    **Type:** <type>
    [**Reply to:** <replyTo>]
    [**Resolved:** true|false]

    <body>
    ```
- **File:** `src/templates/index.ts` MODIFY — export.
- **File:** `src/dashboard/parser.ts` MODIFY
  - **What:** `parseComments(content) → { entries: Comment[]; entryCount: number; updated: string }`. Parse `## <id>` blocks with key/value lines followed by body.

### 5.2 CLI command

- **File:** `src/commands/comment.ts` CREATE
  - **What:** `syntaur comment <assignment-slug-or-id> "text" [--reply-to <id>] [--type question|note|feedback] [--project <slug>]`.
    - When `--project` present: resolve as project-nested slug. Else: treat as UUID, use `resolveAssignmentById`.
    - Read `assignmentDir/comments.md` (create from template if absent).
    - Generate comment id via `generateId()` (short form).
    - Build entry via `formatCommentEntry`. Author: `process.env.USER || 'unknown'` or explicit `--author` flag.
    - Update `entryCount`, `updated` in frontmatter via `setTopLevelField`.
    - Replace empty placeholder OR append.
    - Output: `Added comment <id> to <assignment>`.
- **File:** `src/index.ts` MODIFY — register `comment` subcommand.

### 5.3 Assignment template + status rollup cleanup

- **File:** `src/templates/assignment.ts` MODIFY
  - **What:** Remove `## Questions & Answers\n\nNo questions yet.` body section. Add `[Comments](./comments.md)` to `## Links`.
- **File:** `src/commands/create-assignment.ts` MODIFY
  - **What:** Write `comments.md` via `renderComments` alongside other companion files.
- **File:** `src/dashboard/api-write.ts` MODIFY
  - **What:** Both create routes write `comments.md`. Add write helper route for comments:
    - `POST /api/projects/:slug/assignments/:aslug/comments` (body: `{ text, type?, replyTo?, author? }`) — mediated append.
    - `POST /api/assignments/:id/comments` — same for standalone.
    - `PATCH /api/projects/:slug/assignments/:aslug/comments/:commentId/resolved` (body: `{ resolved: boolean }`) — toggle resolved on a `type: question` comment.
    - Standalone equivalents.
- **File:** `src/templates/index-stubs.ts` MODIFY
  - **What:** `renderStatus`: rename `unansweredQuestions: 0` → `openQuestions: 0`. Update the prose line `- **0 unanswered** questions` → `- **0 open** questions`.
- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** `buildProjectRollup` — compute `openQuestions` by reading every assignment's `comments.md`, filtering `type === 'question' && resolved !== true`. Drop old `unansweredQuestions` reference. `ProjectRollup` type rename field.
- **File:** `src/dashboard/types.ts` MODIFY
  - **What:** Rename `unansweredQuestions` → `openQuestions` on rollup/attention types.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY — mirror rename.

### 5.4 Dashboard UI

- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** `buildAssignmentDetail` reads `comments.md`; attaches `comments: { entries, entryCount, updated }`.
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` MODIFY
  - **What:** Add Comments tab. Thread view with replies nested under parents. Inline "Add comment" form posting to `POST /api/.../comments`. Resolve toggle on question-type comments.

### 5.5 Skills + docs + tests

- **Files:** `platforms/claude-code/skills/{create-assignment,plan-assignment,grab-assignment,complete-assignment,syntaur-protocol}/SKILL.md`, codex mirrors MODIFY
  - **What:** Replace every "Questions & Answers" reference with "Comments". Instruct agents to use `syntaur comment` CLI. Remove any "append to `## Questions & Answers` section" guidance. Note CLI-mediation preserves single-writer.
- **Files:** `platforms/*/references/{protocol-summary,file-ownership}.md` MODIFY
  - **What:** Add `comments.md` row. Owner = any agent via `syntaur comment` CLI (mediated). Readers = all.
- **Files:** `src/templates/{codex-agents,cursor-rules,opencode-config}.ts` MODIFY — mention `comments.md` + `syntaur comment`.
- **File:** `src/__tests__/adapter-templates.test.ts` MODIFY — assert substrings.
- **File:** `docs/protocol/file-formats.md` MODIFY
  - **What:** Add `comments.md` section documenting frontmatter, body format, comment fields, CLI mediation. Remove any `## Questions & Answers` references. Update `_status.md` `needsAttention.openQuestions` field docs.
- **File:** `src/__tests__/comment.test.ts` CREATE
  - **What:** `syntaur comment <uuid> "q" --type question` appends to `comments.md`. `--reply-to` sets field. entryCount increments. Placeholder replaced on first entry. Empty `text` rejected.
- **File:** `src/__tests__/comments-template.test.ts` CREATE — renderComments, formatCommentEntry, parseComments round-trip.
- **File:** `src/__tests__/templates.test.ts` MODIFY — assignment body no longer has `## Questions & Answers`.
- **File:** `src/__tests__/dashboard-parser.test.ts` MODIFY — parseComments, parseProject rollup stubs.
- **File:** `src/__tests__/dashboard-api.test.ts` MODIFY — `buildProjectRollup.openQuestions` counted from comments.md; AssignmentDetail includes comments.
- **File:** `src/__tests__/dashboard-write.test.ts` MODIFY — comment append, resolved toggle routes.

### 5.6 Chunk 5 verification

- `npm run typecheck`, `cd dashboard && npx tsc -b --noEmit`, `npx vitest run`
- Manual: `syntaur comment <uuid> "why?" --type question`; dashboard Comments tab shows it. Toggle resolved; `openQuestions` rollup decrements.
- **Commit:** `feat(assignments): add comments.md with CLI mediation (replaces Q&A section)`

---

## Chunk 6 — Cross-assignment backlinks + `syntaur request`

Wiki-style backlinks (passive) + todo injection CLI (active).

### 6.1 Backlink computation

- **File:** `src/dashboard/api.ts` MODIFY
  - **What:** Extend `getAssignmentDetail` / `buildAssignmentDetail`: after resolving self, scan every other assignment (project-nested via projects tree + standalone via assignmentsDir). For each, search `todos`, `comments.md`, `progress.md`, `handoff.md` bodies for markdown links. A link resolves to target when:
    - Relative path: `../other-slug/assignment.md` resolves within same project
    - Absolute route path: `/projects/<slug>/assignments/<aslug>/assignment.md` or `/assignments/<id>/assignment.md`
  - Reverse-map → on the target assignment, attach `referencedBy: { sourceId, sourceSlug, sourceTitle, sourceProjectSlug, mentions }[]`. Cap list at 50 per target.
  - Helper: `extractAssignmentLinks(body: string, fromDir: string, projectsDir: string, assignmentsDir: string) → ResolvedLinkTarget[]`.
  - Cache per-request (compute once in `getAssignmentDetail` for detail, or build a full index for list views where cheap).
- **File:** `src/dashboard/types.ts` MODIFY — add `referencedBy` field to `AssignmentDetail`.
- **File:** `dashboard/src/hooks/useProjects.ts` MODIFY — mirror type.

### 6.2 Dashboard UI

- **File:** `dashboard/src/pages/AssignmentDetail.tsx` MODIFY
  - **What:** Add "Referenced by" panel below header. Renders each source as `<sourceTitle> (N mentions)` linking to the source's detail page.

### 6.3 `syntaur request` CLI

- **File:** `src/commands/request.ts` CREATE
  - **What:** `syntaur request <target-assignment-slug-or-id> "text" [--project <slug>]`.
    - Resolve target like `comment.ts`.
    - Read target's `assignment.md`. Find `## Todos` section.
    - Append line: `- [ ] <text> (from: <source-assignment>)` — source-assignment resolved from `process.env.SYNTAUR_ASSIGNMENT` (set by `grab-assignment`) or CWD inference; else require `--from <slug-or-id>`.
    - Update `updated` timestamp via `setTopLevelField`.
    - Output: `Added todo to <target>`.
- **File:** `src/index.ts` MODIFY — register `request` subcommand.
- **File:** `src/dashboard/api-write.ts` MODIFY (optional mediated route)
  - **What:** Add `POST /api/projects/:slug/assignments/:aslug/todos` and `POST /api/assignments/:id/todos` — accept `{ text, from }`; append to `## Todos`. Source annotation preserved.

### 6.4 Skill text

- **Files:** `platforms/claude-code/skills/{plan-assignment,grab-assignment,syntaur-protocol}/SKILL.md`, codex mirrors MODIFY
  - **What:** Add section "Cross-assignment communication":
    - Passive: link to other assignments via markdown in todos/comments/progress/handoff — they appear as "Referenced by" on the target's dashboard page.
    - Active: use `syntaur request <target> "<task>"` to append a todo on another assignment.
  - Example block showing link syntax and CLI usage.

### 6.5 Docs + tests

- **File:** `docs/protocol/spec.md` MODIFY
  - **What:** Add Section on cross-assignment references. Document link resolution rules and the `syntaur request` command.
- **File:** `src/__tests__/request.test.ts` CREATE
  - **What:** `syntaur request <uuid> "do X"` appends to target's `## Todos`. `(from: ...)` annotation included. `updated` bumped.
- **File:** `src/__tests__/dashboard-api.test.ts` MODIFY
  - **What:** Backlink computation: create two assignments where A links to B; detail of B includes `referencedBy` with A. Cap at 50 enforced.
- **File:** `src/__tests__/dashboard-parser.test.ts` MODIFY — `extractAssignmentLinks` unit coverage.

### 6.6 Chunk 6 verification

- `npm run typecheck`, `cd dashboard && npx tsc -b --noEmit`, `npx vitest run`
- Manual: create two assignments, link from one to the other; dashboard target shows "Referenced by". `syntaur request <target> "fix it"` adds todo.
- **Commit:** `feat(assignments): cross-assignment backlinks and syntaur request CLI`

---

## Chunk 7 — Leverage decision-record.md

Skill-text changes only — grab-assignment loads upstream decision records alongside handoff; plan-assignment prompts for decision capture.

### 7.1 Grab-assignment

- **Files:** `platforms/claude-code/skills/grab-assignment/SKILL.md`, `platforms/codex/skills/grab-assignment/SKILL.md` MODIFY
  - **What:** In the "When `dependsOn` is set" block, after reading each dep's `handoff.md`, also read each dep's `decision-record.md`. Render a "Upstream decisions" section in the loaded context. If the file is missing or empty, note that and move on.

### 7.2 Plan-assignment

- **Files:** `platforms/claude-code/skills/plan-assignment/SKILL.md`, `platforms/codex/skills/plan-assignment/SKILL.md` MODIFY
  - **What:** Add instruction: "Throughout planning, record meaningful choices (library picks, schema decisions, architecture calls) to this assignment's `decision-record.md` using the `## <short title>` entry format. Use the `POST /api/.../decision-record/entries` endpoint or edit the file directly as the assignment owner. The dashboard Decision Record tab will surface them; downstream assignments that depend on this one will auto-load them during `grab-assignment`."

### 7.3 Reference + adapter mirrors

- **Files:** `platforms/claude-code/references/protocol-summary.md`, `platforms/codex/references/protocol-summary.md` MODIFY
  - **What:** Note the decision-record auto-loading behavior in the grab-assignment summary.
- **Files:** `src/templates/{codex-agents,cursor-rules,opencode-config}.ts` MODIFY — mention that upstream decision records load on grab.
- **File:** `src/__tests__/adapter-templates.test.ts` MODIFY — add substring asserts.

### 7.4 Chunk 7 verification

- `npx vitest run src/__tests__/adapter-templates.test.ts` green.
- Manual: view the updated SKILL.md files; confirm `bash -n` on hook scripts (unchanged but re-run).
- **Commit:** `feat(skills): grab-assignment auto-loads upstream decision records; plan-assignment prompts for decision capture`

---

## Chunk 8 — Tag + publish

Version bump + tag. Separate commit to keep release boundary clean.

### 8.1 Version bump

- **File:** `package.json` MODIFY
  - **What:** `"version": "0.1.14"` → `"version": "0.2.0"` (minor bump reflects breaking protocol).
- **File:** `src/utils/config.ts` already bumped `DEFAULT_CONFIG.version` to `'2.0'` in chunk 1 — re-verify.
- **File:** `src/templates/manifest.ts` already `version: "2.0"` — re-verify.

### 8.2 Pre-tag checklist (must all pass)

- [ ] `npm run typecheck` green
- [ ] `cd dashboard && npx tsc -b --noEmit` green
- [ ] `npx vitest run` green, no added `.skip`, no new `it.todo`
- [ ] `bash -n platforms/claude-code/hooks/enforce-boundaries.sh`
- [ ] `bash -n platforms/claude-code/hooks/session-cleanup.sh`
- [ ] `bash -n platforms/codex/scripts/enforce-boundaries.sh`
- [ ] `bash -n platforms/codex/scripts/session-cleanup.sh`
- [ ] `node dist/index.js doctor` against a fresh `examples/sample-project/` reports no errors
- [ ] `Grep pattern="[Mm]ission" path="src"` returns 0 matches (excluding test strings that explicitly test renaming)
- [ ] `Grep pattern="[Mm]ission" path="dashboard/src"` returns 0 matches
- [ ] `Grep pattern="[Mm]ission" path="platforms"` returns 0 matches
- [ ] `Grep pattern="[Mm]ission" path="docs"` returns 0 matches
- [ ] `Grep pattern="agent\\.md|claude\\.md" path="src" path="platforms" path="docs"` returns 0 matches (outside of this plan itself)
- [ ] `node dist/index.js --version` prints `0.2.0`
- [ ] Manual smoke on fresh `~/.syntaur/`: `init`, `create-project`, `create-assignment` (both project-nested and `--one-off`), `start`, `comment`, `request`, `complete`, dashboard view

### 8.3 Tag

- **Commit:** `chore(release): v0.2.0 — protocol v2.0 (projects, standalone assignments, comments, progress, backlinks)`
- `git tag v0.2.0`
- Do NOT push tag unless user explicitly requests.

---

## Dependencies

- No new npm packages.
- **Chunk order is strict:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Chunk 1 must be atomically complete (full rename, typecheck green) before chunk 2 begins to avoid straddling identifier tangles.
- Within chunk 2, task order: 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7. Backend resolver + types must exist before CLI can import them; API + backend writes before frontend hooks.
- Within chunks 4/5: template + parser first, then assignment template cleanup, then dashboard surface, then skills + docs + tests.
- Chunk 6 depends on 4/5 completing so that `progress.md` and `comments.md` bodies exist to be scanned for backlinks.
- Chunk 7 is text-only and could run in parallel with chunk 6 if needed but keep sequential for review simplicity.

## Final verification

Already covered in chunk 8 pre-tag checklist.

## Notes for the implementer

- **When renaming a TypeScript identifier, prefer `Edit` with `replace_all` scoped per file over bulk regex.** Use `Grep` first to list files, then walk them. This preserves context accuracy and avoids false-positive replacements in comments, test strings, and incidental matches.
- **Keep commits clean.** After each chunk, confirm `git status` shows only the chunk's intended files. Rename-via-`git mv` when feasible (the Bash tool supports it) so git tracks renames cleanly.
- **When in doubt on a v1 vs v2 behavior,** prefer hard cutover. User has confirmed no users and no migration story; any accidental backward-compat cruft should be deleted.
- **Dashboard WebSocket event names** must rename `mission-updated` → `project-updated` and add `assignment-updated` for standalone. Clients listen by name — any missed instance silently breaks live updates.
- **`syntaur comment` and `syntaur request` set the single-writer invariant by routing through CLI.** Agents must NOT be told they can edit `comments.md` directly on a peer's assignment. Own-progress writes directly to `progress.md` are OK because progress is always self-owned.
