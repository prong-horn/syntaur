---
assignment: cli-parity-ship-missing-commands-and-back-manual-edit-skills
status: in_progress
created: "2026-06-03T13:30:00Z"
updated: "2026-06-03T14:05:00Z"
---

> **Revision note (codex plan-review, round 2, incorporated):** `removeWorktree` hardcodes `--force` (`git-worktree.ts:57`) → D3 now includes a `{ force }` util change so non-force removal works. `plan create` must NOT reuse `buildNewPlanStub` (always renders a `v<N>`/`Supersedes` revision, `plan.ts:206`) → D4 adds a separate `buildInitialPlanStub()`. The acceptance criterion "initial plan no longer hand-written by `plan-assignment`" → D4 now also updates `skills/plan-assignment/SKILL.md` Step 5b to call `syntaur plan create`. `parseProgress()` doesn't expose `generated` (`parser.ts:456`) → C2 preserves raw frontmatter instead of round-tripping. `mirror-skills` is now a single explicit step (C7) right after the SKILL.md edits, with the final gate re-running it idempotently.
>
> **Revision note (codex plan-review, round 1, incorporated):** Corrected three load-bearing inaccuracies and tightened five under-specified tasks. (1) `DEFAULT_CONFIG.statuses` is `null` and `DEFAULT_CONFIG` is file-private (`config.ts:135,152`) — defaults come from `DEFAULT_STATUSES` (`src/lifecycle/types.ts`), `DEFAULT_TRANSITION_TABLE` (`src/lifecycle/state-machine.ts`), and the file-private `DEFAULT_STATUS_COLORS`/`toTitleCase` in `src/dashboard/api.ts`; `status init`/`list` use a new shared `buildDefaultStatusConfig()` (Group A). (2) `applyStatusResolutions` `mode:'delete'` **deletes assignment directories** (`status-config-resolution.ts:269`+) — it must NOT back `status remove`; the skill requires affected assignments to *remain* with the now-invalid status for `doctor` to flag. (3) `applyStatusResolutions` cannot implement `rename` (its remap targets must be valid in BOTH old and new configs) — `rename` gets a bespoke buffer-write-rollback transaction reusing the *idiom*, not the function. Also: standardize assignment resolution on the canonical `resolveAssignmentById` (`src/utils/assignment-resolver.ts:15`); `session.ts` has no generic `--assignment/--project` resolver today (must add). Exact flag surfaces for `workspace set`, `session save`, `resource/memory update`, `worktree remove/prune` enumerated below.

# CLI parity: ship missing commands and back manual-edit skills

**Date:** 2026-06-03
**Complexity:** medium
**Tech Stack:** TypeScript (ESM, `"type":"module"`, Node ≥20), Commander v13, tsup (build), vitest (tests). CLI entry `bin/syntaur.js` → `dist/index.js`. Build: `npm run build`. Test: `npm test`. Typecheck: `npm run typecheck`. Skill mirror: `npm run mirror-skills` (after editing any `skills/<name>/SKILL.md`).

## Objective

Close the CLI/skill/protocol drift so every shipped skill is backed by a real `syntaur` CLI command, every CRUD-incomplete command group is completed, and high-traffic protocol writes (workspace, progress, session, unassign) go through atomic/validated CLI commands instead of skills hand-editing markdown. Ships in 5 incremental, independently-committable groups (A–E).

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/config.ts` | MODIFY | Export `serializeStatusConfig` + `parseStatusConfig` (file-private); add exported `buildDefaultStatusConfig()` (since `DEFAULT_CONFIG.statuses` is `null`) |
| `src/dashboard/api.ts` | MODIFY | Export `DEFAULT_STATUS_COLORS` + `toTitleCase`; refactor `getStatusConfig()` no-block branch to call `buildDefaultStatusConfig()` so CLI/dashboard share one default source |
| `src/commands/status.ts` | CREATE | `status` group: list/init/reset/add/set/reorder/remove/rename/transition add/transition remove (per-op array transforms + bespoke atomic `rename`; `remove --force` edits config only, never deletes assignments) |
| `src/lifecycle/transitions.ts` | MODIFY | Add `executeUnassign` / `executeUnassignByDir` (inverse of assign) |
| `src/commands/_lifecycle-helper.ts` | MODIFY | Add `runUnassign` (mirror `runAssign`) |
| `src/commands/workspace.ts` | CREATE | `workspace set` — writes 4 `workspace.*` fields atomically, bumps `updated` |
| `src/commands/progress.ts` | CREATE | `progress log <text>` — append reverse-chron entry, bump `entryCount` + `updated` |
| `src/commands/session.ts` | MODIFY | Add `save` verb (writes `sessions/<id>/summary.md`) |
| `src/commands/plan.ts` | MODIFY | Add `create` verb (initial plan.md) |
| `src/commands/resource.ts` | MODIFY | Add list/show/update/remove |
| `src/commands/memory.ts` | MODIFY | Add list/show/update/remove |
| `src/commands/worktree.ts` | MODIFY | Add list and remove/prune; clear `workspace.*` on remove |
| `src/utils/git-worktree.ts` | MODIFY | `removeWorktree` gains `{ force }` opt (currently hardcodes `--force`) so non-force removal is possible |
| `src/index.ts` | MODIFY | Import + register `statusCommand`, `workspaceCommand`, `progressCommand`, `unassign`; existing groups already registered |
| `skills/manage-statuses/SKILL.md` | (no change) | Already matches the `status` table being implemented — implement TO this spec |
| `skills/set-workspace/SKILL.md` | MODIFY | Replace hand-edit steps with `syntaur workspace set` |
| `skills/log-progress/SKILL.md` | MODIFY | Replace Markdown-only steps with `syntaur progress log <text>` |
| `skills/save-session-summary/SKILL.md` | MODIFY | Back with `syntaur session save` |
| `skills/clear-assignment/SKILL.md` | MODIFY | Drop "skip if unsupported" fallback; `unassign` now always exists |
| `skills/plan-assignment/SKILL.md` | MODIFY | Initial-plan case (Step 5b) calls `syntaur plan create` instead of hand-writing `plan.md` |
| `docs/cli.md` | MODIFY | Add status, workspace, progress, session save, unassign, resource, memory, worktree, plan create sections |
| `src/__tests__/*.test.ts` | CREATE | One test file per new command (see tasks) |

## Tasks

> Order is the safe-commit order: A (prereq exports) → B (status group) → C (protocol writes + skills) → D (CRUD completion) → E (docs + mirror + full verification). Commit after each group.

### Group A — Prerequisite: export shared status serializers + default builder

#### A1. Export status serializers + add a shared default-config builder
- **File:** `src/utils/config.ts` (MODIFY) and `src/dashboard/api.ts` (MODIFY)
- **What:**
  1. Add `export` to `function serializeStatusConfig` (private at ~L429) and `function parseStatusConfig` (private at ~L321). Do NOT change their bodies or the internal callers (`writeStatusConfig` ~L1231, `readConfig` ~L1471). `StatusConfig`/`StatusDefinition`/`StatusTransition` (~L33–55), `writeStatusConfig` (~L1231), `deleteStatusConfig` (~L1282) are already exported.
  2. **Add an exported `buildDefaultStatusConfig(): StatusConfig`** that materializes the built-in defaults — because `DEFAULT_CONFIG.statuses` is `null` (`config.ts:152`) and `DEFAULT_CONFIG` is file-private, so `init` CANNOT read defaults from it. The builder produces exactly what `getStatusConfig()`'s no-block branch builds (`api.ts:458–473`): `statuses = DEFAULT_STATUSES.map(id => ({ id, label: toTitleCase(id), color: DEFAULT_STATUS_COLORS[id] ?? 'gray', terminal: id === 'completed' || id === 'failed' }))`, `order = [...DEFAULT_STATUSES]`, `transitions =` the `DEFAULT_TRANSITION_TABLE` entries mapped to `{from,command,to}`. Source the inputs from `src/lifecycle` (`DEFAULT_STATUSES` in `lifecycle/types.ts:5`, `DEFAULT_TRANSITION_TABLE` in `lifecycle/state-machine.ts:28`, both re-exported via `lifecycle/index.js`).
  3. `DEFAULT_STATUS_COLORS` (`api.ts:382`) and `toTitleCase` (`api.ts:391`) are file-private in `api.ts`. **Export both** (or move the color map next to `DEFAULT_STATUSES` in `lifecycle/types.ts` and export `toTitleCase` from a shared util) so `buildDefaultStatusConfig` and `getStatusConfig` use ONE source. Then refactor `getStatusConfig()`'s else-branch (`api.ts:458–473`) to call `buildDefaultStatusConfig()` for its `statuses`/`order`/`transitions` so CLI and dashboard cannot drift (this is the assignment's "CLI and dashboard stay in sync" requirement, concretely enforced).
- **Pattern:** Mirror the already-exported `updateAgentsConfig` (~L1576) export style. Keep `buildDefaultStatusConfig` pure (no I/O).
- **Verify:** `npm run build && npm run typecheck` (no behavior change to the dashboard; `status-config*` tests still green).

### Group B — `status` command group (highest priority; broken skill)

#### B1. Implement the `status` command group
- **File:** `src/commands/status.ts` (CREATE)
- **What:** New `Command('status')` whose verbs match `skills/manage-statuses/SKILL.md` (§ command table) **exactly** — flags, names, behavior. The dashboard backend (`api-status-config.ts`) does NOT implement per-op add/set/reorder/rename — its React frontend computes the full `{statuses,order,transitions}` arrays and POSTs them; the backend only validates `resolutions` for dropped ids and writes. So the CLI must implement the per-op array transforms itself (pure data ops on a `StatusConfig`) and persist via `writeStatusConfig`.
  - `list [--json]` — resolve via `getStatusConfig()` (`api.ts:424`); its `custom` flag is the `source` marker (`custom:true` → `config`, `custom:false` → `default`). `--json` emits `{ statuses, order, transitions, source }`.
  - `init [--force]` — write `buildDefaultStatusConfig()` (Group A) via `writeStatusConfig`. If a `statuses:` block already exists, refuse unless `--force` (per skill: "`init --force` overwrites a custom block").
  - `reset [--force]` — `deleteStatusConfig()` (removes the block). `--force` to skip the confirm guard.
  - `add <id> --label <label> [--color <hex>] [--icon <name>] [--description <text>] [--terminal] [--after <id> | --before <id> | --at-end]` — load current block via `parseStatusConfig(<config.md>)`; **if null, error "run `syntaur status init` first"** (matches skill Step 2 and the all-or-nothing runtime). Append the new `StatusDefinition`; insert into `order` per the mutually-exclusive position flag (default `--at-end`); write.
  - `set --id <id> [--label] [--color] [--icon] [--description] [--terminal true|false]` — mutate metadata in place (no id change). `--terminal` parses literal `true`/`false`.
  - `reorder <id,id,...>` — replace `order`; the CSV must be a permutation of current ids (reject drops/extras with a clear message + exit 1).
  - `remove <id> [--force]` — WITHOUT `--force`: `scanAssignmentsByStatus(projectsDir, assignmentsDir, [id])`; if any assignment references it, print the offender list and exit 1 (DO NOT delete). WITH `--force`: **edit `config.md` only** — drop the status from `statuses` + `order`, and drop every `transition` whose `from === id || to === id`; write via `writeStatusConfig`. **Affected `assignment.md` files are intentionally left untouched** (they now reference an undefined status; `doctor` flags them — per skill Step 4 / Safety notes). ⚠️ Do NOT use `applyStatusResolutions` here — its `delete` mode **deletes assignment directories** (`status-config-resolution.ts:269`+).
  - `rename <id> --to <new-id> [--label <label>]` — **bespoke atomic transaction** (reuse the buffer-write-rollback *idiom* from `applyStatusResolutions`, NOT the function — that function only remaps to a target valid in both configs, it cannot re-id). Steps: (a) load + validate current block (id exists, new-id not already present); (b) `scanAssignmentsByStatus(projectsDir, assignmentsDir, [id])` to find affected assignments; (c) build the renamed `StatusConfig` (rename in `statuses[].id`, `order[]`, and every `transitions[].from`/`.to` equal to `id`; keep label unless `--label`); (d) buffer the original `config.md` + every affected `assignment.md`; (e) write the new `config.md` (`writeStatusConfig`) and rewrite each affected assignment's `status: <old>` → `status: <new>` via `updateAssignmentFile`; (f) on ANY write failure, restore every buffered original then throw a `StatusResolutionError`-style error. `git` will show diffs across many `assignment.md` — intentional (skill Step 4).
  - `transition add --from <id> --command <cmd> --to <id> [--label <label>] [--requires-reason]` / `transition remove --from <id> --command <cmd>` — pure transforms on the `transitions` array; write.
  - **Every mutating verb supports `--dry-run`:** print a unified diff of the would-be serialized `statuses:` block (`serializeStatusConfig(before)` vs `serializeStatusConfig(after)`) and exit WITHOUT writing. For `rename`, ALSO print a per-file frontmatter diff (`status:` line) for each affected `assignment.md`.
- **What (reuse):** `serializeStatusConfig`/`parseStatusConfig`/`writeStatusConfig`/`deleteStatusConfig`/`buildDefaultStatusConfig` (`config.ts`); `getStatusConfig` (`api.ts`); `scanAssignmentsByStatus` (~L51), `verifyNoDriftedOrphans` (~L320), `StatusResolutionError` (~L31) from `status-config-resolution.ts`. `projectsDir`/`assignmentsDir` come from the same path helpers `api-status-config.ts`'s router is constructed with (resolve from `SYNTAUR_HOME`).
- **Pattern:** CRUD skeleton from `src/commands/views.ts` (per-verb `.command()` + `.requiredOption()`/`.option('--json')`, exported `runStatusX()` for unit tests, shared `fail(error)` helper at `views.ts:67`). `add --after/--before/--at-end` mirrors `agents set`'s mutually-exclusive position flags. Per-verb try/catch matching typed errors → message + `process.exit(1)`, like `lease.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/status-cmd.test.ts`

#### B2. Register the `status` group
- **File:** `src/index.ts` (MODIFY)
- **What:** `import { statusCommand } from './commands/status.js';` near the other command imports (~L49–58); `program.addCommand(statusCommand);` in the registration block (~L898–911).
- **Verify:** `node bin/syntaur.js status --help` lists all verbs; `node bin/syntaur.js --help` shows `status`.

#### B3. Status group tests
- **File:** `src/__tests__/status-cmd.test.ts` (CREATE)
- **What:** Cover every verb incl. `--json`, `--dry-run` (asserts NO write), `init`/`init --force`/`reset`, `add` position flags, `set --terminal true|false`, `reorder` permutation validation. **Two safety-critical cases:** (1) `remove <id> --force` on a status referenced by an assignment leaves that `assignment.md` ON DISK with its (now-invalid) status — assert the file still exists and `status:` is unchanged, and that config dropped the id + its transitions; `remove` without `--force` exits 1 and lists the offender. (2) `rename <old> --to <new>` rewrites BOTH `config.md` and every affected `assignment.md` `status:` field atomically; simulate a mid-write failure path if feasible to assert rollback (or at least assert all affected files updated on success). Plus the "unknown command" regression: every invocation documented in the skill succeeds (no Commander "unknown command").
- **Pattern:** `src/__tests__/views-cmd.test.ts` + `resource-add.test.ts` — `mkdtemp` temp `SYNTAUR_HOME`, write minimal `config.md` (+ `projects/<p>/project.md` and assignment.md fixtures for rename/remove), `spawn(process.execPath, [CLI_ENTRY, ...args], {env:{...process.env, SYNTAUR_HOME}})`, `CLI_ENTRY=resolve(__dirname,'..','..','bin','syntaur.js')`, assert `result.code` + `stdout`/`stderr`; `--json` via `JSON.parse`. (Tests spawn the built bin, so `npm run build` must precede.)
- **Verify:** `npm run build && npx vitest run src/__tests__/status-cmd.test.ts`

### Group C — Protocol-write commands + skill updates

#### C1. `workspace set`
- **File:** `src/commands/workspace.ts` (CREATE) + `src/index.ts` (MODIFY: import + `program.addCommand(workspaceCommand)`)
- **What:** `workspace set` with the exact flags the skill documents: `--repository <path>`, `--worktree-path <path>`, `--branch <name>`, `--parent-branch <name>`, plus resolution flags `--assignment <slug-or-id>` `[--project <slug>]`. Behavior: (a) resolve the assignment file — context.json `assignmentDir` OR `resolveAssignmentById(projectsDir, assignmentsDir, <slug-or-id>)` / the `worktree.ts:37` `resolveAssignmentPath` pattern for slug+`--project`; (b) **pre-write validation** — run the same check `syntaur doctor --assignment <path> --json` performs (reuse `validateAssignmentFile`, `src/commands/doctor.ts:35`); if not ok, print errors verbatim and exit 1 WITHOUT writing; (c) write the four fields via `updateAssignmentWorkspace()` (`src/lifecycle/frontmatter.ts:234`) and bump `updated` via `updateAssignmentFile` (~L166); (d) **post-write re-validation** — re-run `validateAssignmentFile`; if it fails, restore the buffered prior file content and exit 1 (never leave a half-written file). Unrelated frontmatter must be preserved (proven safe by `workspace-frontmatter.test.ts`).
- **Pattern:** resolution skeleton from `worktree.ts` (`readContext` ~L27, `resolveAssignmentPath` ~L37); do NOT write new frontmatter regex.
- **Verify:** `npm run build && npx vitest run src/__tests__/workspace-set.test.ts`

#### C2. `progress log <text>`
- **File:** `src/commands/progress.ts` (CREATE) + `src/index.ts` (MODIFY: import + register)
- **What:** `progress log <text>` appends a timestamped entry to `<assignmentDir>/progress.md`: newest entry immediately AFTER the `# Progress` H1 (reverse-chronological), increment `entryCount`, bump `updated`. **Must replace the `No progress yet.` placeholder** (`src/templates/progress.ts:14`) on the first real entry rather than appending after it, and **preserve the existing `assignment` + `generated` frontmatter fields**. ⚠️ `parseProgress()` does NOT expose `generated` (`src/dashboard/parser.ts:456`), so DO NOT round-trip the whole file through it for the write — edit frontmatter in place (preserve `generated`/`assignment` raw) and use `formatProgressEntry` (`src/templates/index.js`) only to render the new entry block. Same resolution as C1 (context.json or `--assignment/--project`).
- **Pattern:** File shape per `src/__tests__/progress-template.test.ts`; skill spec `skills/log-progress/SKILL.md`.
- **Verify:** `npm run build && npx vitest run src/__tests__/progress-log.test.ts`

#### C3. `session save`
- **File:** `src/commands/session.ts` (MODIFY — add `save`; `resume` ~L184 already exists)
- **What:** `session save [--session-id <id>] [--from-file <path>] [--assignment <slug-or-id>] [--project <slug>]`. Behavior: (a) resolve `assignmentDir` (context.json or `resolveAssignmentById` — NB `session.ts` has NO generic `--assignment/--project` resolver today; add one mirroring `worktree.ts:37`); (b) resolve `sessionId` from `--session-id` else context.json `sessionId` — abort with a clear message if missing (never invent one); (c) `mkdir -p <assignmentDir>/sessions/<sessionId>/`; (d) if `summary.md` already exists, **preserve its `created` frontmatter timestamp**, else `created = now`; (e) the section BODY comes from `--from-file <path>` or piped stdin if present, otherwise write the standard skeleton from `skills/save-session-summary/SKILL.md` Step 4 (Snapshot / What Was Done / What's Next / Open Questions / Load-Bearing Context); the CLI always owns the frontmatter (`assignment`, `sessionId`, `created`, `updated`); (f) write/overwrite `summary.md`. Must NOT touch `handoff.md`.
- **Pattern:** existing `resume` verb in same file; `session-resume.test.ts` harness.
- **Verify:** `npm run build && npx vitest run src/__tests__/session-save.test.ts`

#### C4. `unassign <assignment>`
- **File:** `src/lifecycle/transitions.ts` (MODIFY) + `src/commands/_lifecycle-helper.ts` (MODIFY) + `src/index.ts` (MODIFY)
- **What:** Add `executeUnassign` / `executeUnassignByDir` in `transitions.ts` (set `assignee: null` + bump `updated` via `updateAssignmentFile`) — inverse of `executeAssign` (~L144) / `executeAssignByDir` (~L232). Add `runUnassign` in `_lifecycle-helper.ts` mirroring `runAssign` (~L68–98, same project/standalone resolution incl. `resolveAssignmentById`). Register `unassign` in `index.ts` as a `program.command('unassign')` inline block mirroring the existing inline `program.command('assign')` (~L252) — NOT a separate exported Command.
- **Pattern:** `runAssign` + the inline `assign` block in `index.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/unassign.test.ts`

#### C5. Tests for C1–C4
- **Files:** `src/__tests__/workspace-set.test.ts`, `progress-log.test.ts`, `session-save.test.ts`, `unassign.test.ts` (all CREATE)
- **What:** Spawn-the-bin tests. workspace-set: all 4 fields written + `updated` bumped + unrelated frontmatter preserved + **refuses to write a malformed file (pre-validation) and rolls back on post-validation failure**. progress-log: **`No progress yet.` placeholder replaced**, newest-after-H1 ordering, `entryCount` increment, `assignment`/`generated` preserved. session-save: `summary.md` under `sessions/<id>/`, **`created` preserved on re-save**, skeleton when no body, `handoff.md` untouched, aborts when no sessionId. unassign: `assignee` cleared to null + `updated` bumped.
- **Pattern:** `views-cmd.test.ts` harness; `workspace-frontmatter.test.ts` for frontmatter assertions.
- **Verify:** `npm run build && npx vitest run src/__tests__/workspace-set.test.ts src/__tests__/progress-log.test.ts src/__tests__/session-save.test.ts src/__tests__/unassign.test.ts`

#### C6. Update protocol-write skills
- **Files:** `skills/set-workspace/SKILL.md`, `skills/log-progress/SKILL.md`, `skills/save-session-summary/SKILL.md`, `skills/clear-assignment/SKILL.md` (all MODIFY)
- **What:**
  - `set-workspace`: replace Steps 2–6 hand-edit + manual doctor calls with `syntaur workspace set --repository … --worktree-path … --branch … --parent-branch …` (the CLI now does the doctor pre/post-validation + rollback internally).
  - `log-progress`: replace the "Markdown-only — no CLI verb" guidance with `syntaur progress log "<text>"`.
  - `save-session-summary`: back Steps 2–4 with `syntaur session save` (CLI owns dir creation + `created` preservation + frontmatter; the skill still authors the section body and passes it via `--from-file`/stdin).
  - `clear-assignment`: drop the "Skip this flag if the CLI does not support `unassign`" fallback (~L32, L69); keep `syntaur unassign <slug> --project <project>` in Step 3.
  - (`plan-assignment` is updated in D4, not here.)
- **Note:** Edit ONLY `skills/<name>/SKILL.md`; `platforms/<kind>/skills` are gitignored build artifacts.
- **Verify:** Visual diff; then run C7 mirror immediately.

#### C7. Mirror skills (run immediately after C6/D4 skill edits)
- **What:** Run `npm run mirror-skills` right after the SKILL.md edits in C6 and D4 land, so the working tree's `platforms/<kind>/skills/` matches the canonical sources before any test/build gate. This is the single canonical mirror step; Group E's final gate re-runs it idempotently (also runs in `prepack`, `package.json:60`).
- **Verify:** `npm run mirror-skills` exits 0; `git status` shows the mirrored `platforms/**` changes (if any are tracked) or none (if gitignored).

### Group D — Complete CRUD-incomplete command groups

#### D1. `resource` list/show/update/remove
- **File:** `src/commands/resource.ts` (MODIFY — `add` ~L99 + `resourceCommand` ~L95 exist; group already registered in `index.ts`)
- **What:** Add `list --project <slug> [--json]`, `show <slug> --project <slug> [--json]`, `update <slug> --project <slug> [--name <name>] [--source <url-or-path>] [--category <name>] [--related-assignments <slugs>]`, `remove <slug> --project <slug> [--force]`. `update` edits only the supplied fields, bumps the resource's `updated`. Use `parseResource` (`src/dashboard/parser.ts` ~L496) for `show`/`list`. Call `rebuildResourcesIndex` (`src/utils/project-indexes.ts` ~L32) after EVERY mutation (update + remove, not just add).
- **Pattern:** `views.ts` CRUD skeleton (exported `runResourceX()` per verb, `--json` on read verbs, shared `fail`); existing `runResourceAdd` in the same file (mirror its field set).
- **Verify:** `npm run build && npx vitest run src/__tests__/resource-crud.test.ts`

#### D2. `memory` list/show/update/remove
- **File:** `src/commands/memory.ts` (MODIFY — `add` ~L105 + `memoryCommand` ~L101 exist; group registered)
- **What:** Same shape as D1 with memory's fields: `update <slug> --project <slug> [--name] [--source] [--scope] [--source-assignment] [--related-assignments]`; `list`/`show`/`remove` parallel to D1. Use `parseMemory` (`parser.ts` ~L523) and `rebuildMemoriesIndex` (~L67) after every mutation.
- **Pattern:** `resource.ts` (D1) / `views.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/memory-crud.test.ts`

#### D3. `worktree` list + remove/prune (incl. `git-worktree.ts` util change)
- **Files:** `src/commands/worktree.ts` (MODIFY — `create` ~L107 + helpers `readContext`/`resolveAssignmentPath` exist; group registered) AND `src/utils/git-worktree.ts` (MODIFY).
- **Util change (required):** `removeWorktree(repository, worktreePath)` currently passes `git worktree remove --force` **unconditionally** (`git-worktree.ts:57–66`). To make non-force removal actually possible, change the signature to `removeWorktree(repository, worktreePath, opts?: { force?: boolean })` and only append `--force` when `opts.force` is true (default false → git refuses a dirty/locked worktree). Update the existing call site(s) accordingly (preserve current behavior where appropriate).
- **What:** Add `list [--json]` (enumerate git worktrees; `listBranches` ~L80 for branch data) and `remove [--assignment <slug-or-id>] [--project <slug>] [--delete-branch] [--force]` (alias `prune`). Behavior order (define failure semantics): (1) resolve the assignment + its `workspace.worktreePath`/`branch`; (2) `removeWorktree(repo, path, { force })` — without `--force`, git refuses if the worktree is dirty/locked (report the stderr and exit 1); (3) optionally `deleteBranch` (~L68) when `--delete-branch`; (4) clear the assignment's four `workspace.*` fields via `updateAssignmentWorkspace` and **bump `updated`**. If git teardown (2/3) fails, do NOT clear frontmatter; if frontmatter clear (4) fails after git teardown, report that the worktree was removed but fields weren't cleared (idempotent re-run clears them).
- **Pattern:** existing `create` verb + resolution helpers in same file; `git-worktree.test.ts` / `worktree-create.test.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/worktree-list-remove.test.ts`

#### D4. `plan create` + update `plan-assignment` skill
- **Files:** `src/commands/plan.ts` (MODIFY — `version` ~L321 + `planCommand` ~L317 exist) AND `skills/plan-assignment/SKILL.md` (MODIFY).
- **What (CLI):** Add `create [--assignment <slug-or-id>] [--project <slug>] [--force]` that writes the INITIAL `plan.md`. **Do NOT reuse `buildNewPlanStub` (~L206)** — it always renders a *revision* (`# … Implementation Plan v<N>`, `**Supersedes:** …`, `## Carried-forward tasks`). Add a separate `buildInitialPlanStub()` that renders a clean initial plan (`# <slug> — Implementation Plan`, no Supersedes, sections: Objective / Tasks / Verification, `status: draft`). Reuse `resolveAssignmentDir` (~L39) + `isoNow` (~L202) + `rewriteAssignmentTodos` (~L105). Refuse to overwrite an existing `plan.md` unless `--force`.
- **What (skill):** Update `skills/plan-assignment/SKILL.md` Step 5b (~L77) so the INITIAL-plan case (no plan files exist → `plan.md`) calls `syntaur plan create` instead of hand-writing the file — satisfying the acceptance criterion "initial plan no longer hand-written by `plan-assignment`". The versioned `plan-v<N>.md` path continues to map to `syntaur plan version` (unchanged).
- **Pattern:** existing `version` verb + `buildNewPlanStub` in same file; `plan-version.test.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/plan-create.test.ts`

#### D5. Tests for D1–D4
- **Files:** `src/__tests__/resource-crud.test.ts`, `memory-crud.test.ts`, `worktree-list-remove.test.ts`, `plan-create.test.ts` (all CREATE)
- **What:** Spawn-the-bin coverage per verb, incl. `--json` reads, **`_index.md` regeneration after update AND remove** (assert the table reflects the change, not just add), and worktree-remove clearing `workspace.*` + bumping `updated`. `plan create` refuses to clobber without `--force`.
- **Pattern:** `resource-add.test.ts` / `memory-add.test.ts` / `worktree-create.test.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/resource-crud.test.ts src/__tests__/memory-crud.test.ts src/__tests__/worktree-list-remove.test.ts src/__tests__/plan-create.test.ts`

### Group E — Docs, skill mirror, full verification

#### E1. Update `docs/cli.md`
- **File:** `docs/cli.md` (MODIFY — currently ~112 lines, only `agents` + `launch`)
- **What:** Add sections for `status` (all verbs incl. `transition add/remove`, `--dry-run`/`--force`/`--json`), `workspace set`, `progress log`, `session save`, `unassign`, `resource` (full CRUD), `memory` (full CRUD), `worktree` (list/remove/prune), `plan create`. Follow the existing `## syntaur agents` → `### syntaur agents <verb>` fenced-usage style.
- **Verify:** No shipped skill references a command absent from `node bin/syntaur.js --help`.

#### E2. Full verification gate
- **File:** (build/test artifacts)
- **What:** Skill mirroring already happened in C7 (right after the SKILL.md edits). Here just run the full gate; re-running `mirror-skills` last is idempotent and confirms the tree is clean.
- **Verify:** `npm run build && npm test && npm run typecheck && npm run mirror-skills`

## Dependencies
- No new external packages.
- A1 (export `serializeStatusConfig` + `parseStatusConfig` + add `buildDefaultStatusConfig`) is a hard prerequisite for B1 — do A first. `status init`/`list` depend on `buildDefaultStatusConfig` because `DEFAULT_CONFIG.statuses` is `null`.
- `status remove`/`rename` must NOT call `applyStatusResolutions` (its `delete` mode deletes assignment dirs; its `remap` can't re-id). `remove --force` edits config only; `rename` uses a dedicated buffer-write-rollback transaction.
- Assignment-scoped commands resolve via context.json `assignmentDir` OR the canonical `resolveAssignmentById` (`src/utils/assignment-resolver.ts:15`) for `--assignment <slug-or-id> [--project <slug>]`.
- Tests spawn the built `bin/syntaur.js`, so `npm run build` must run before any new test passes.
- Status command writes to `~/.syntaur/config.md` (or `SYNTAUR_HOME`); the dashboard caches `StatusConfig` per-process and cannot be invalidated by a separate CLI process — the skill already tells the user to restart the dashboard. No code change for cache coherence; tests must not assume cross-process cache invalidation.

## Verification

Full gate (run when all groups complete):
```
npm run build && npm test && npm run typecheck && npm run mirror-skills
```

Per-command smoke:
```
node bin/syntaur.js --help                 # status, workspace, progress, unassign all listed
node bin/syntaur.js status --help          # all 10 verbs incl. transition add/remove
node bin/syntaur.js resource --help        # add, list, show, update, remove
node bin/syntaur.js memory --help          # add, list, show, update, remove
node bin/syntaur.js worktree --help        # create, list, remove/prune
node bin/syntaur.js plan --help            # create, version
```

## Success Criteria (verbatim from assignment acceptance criteria)

### Broken skill — highest priority
- [ ] `syntaur status` command group exists (`list`, `init`, `reset`, `add`, `set`, `reorder`, `remove`, `rename`, `transition add`, `transition remove`) matching exactly what `skills/manage-statuses/SKILL.md` documents — flags, `--dry-run`, `--force`, `--json`, atomic rename across `config.md` + every affected `assignment.md`. Reuses the existing dashboard logic (`src/dashboard/api-status-config.ts`, `serializeStatusConfig()` in `src/utils/config.ts`) so CLI and dashboard stay in sync.
- [ ] Running each documented `syntaur status …` invocation from the skill succeeds (no "unknown command").

### Protocol writes that should be CLI-mediated
- [ ] `syntaur workspace set` writes the four `workspace.*` frontmatter fields atomically (repository, worktreePath, branch, parentBranch), validates, and bumps `updated`. `skills/set-workspace/SKILL.md` updated to call it instead of hand-editing frontmatter.
- [ ] `syntaur progress log <text>` appends a timestamped entry to the active assignment's `progress.md`, increments `entryCount`, bumps `updated`, and preserves reverse-chronological ordering. `skills/log-progress/SKILL.md` updated to call it.
- [ ] `syntaur session save` (writes `sessions/<id>/summary.md` with the standard structure) backs `skills/save-session-summary/SKILL.md`.
- [ ] `syntaur unassign <assignment>` clears the assignee (inverse of `assign`); `skills/clear-assignment/SKILL.md` updated to use it (drop the "skip if unsupported" fallback).

### CRUD-incomplete command groups
- [ ] `syntaur resource` gains `list`, `show`, `update`, `remove` (currently `add` only).
- [ ] `syntaur memory` gains `list`, `show`, `update`, `remove` (currently `add` only).
- [ ] `syntaur worktree` gains `list` and `remove`/`prune` (CLI teardown; currently `create` only).
- [ ] `syntaur plan` gains an initial `create` verb for parity with `version` (initial plan no longer hand-written by `plan-assignment`).

### Cross-cutting
- [ ] Each new command has tests under `src/__tests__/` (mirror existing patterns) and appears in `node bin/syntaur.js --help` / group `--help`.
- [ ] `docs/cli.md` and any affected SKILL.md files are updated; no shipped skill references a command that does not exist.
- [ ] `npm run build` + `npm test` + `npm run typecheck` all pass.
