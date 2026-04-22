# Auto-migrate legacy filesystem state from v0.1.x → v0.2.0+

**Date:** 2026-04-21
**Complexity:** small

## Objective

Users who installed Syntaur before v0.2.0 have on-disk state using the old
"mission" terminology (file `mission.md` at project root, frontmatter
`mission:` field, optional per-project `agent.md` / `claude.md`). The v0.2.0
release renamed the code but shipped **no filesystem migration** — same class
of bug as the sqlite `mission_slug` → `project_slug` issue we just fixed.

Result: `npx syntaur@latest` on a legacy machine shows zero projects in the
dashboard because `listProjectRecords` skips any project directory whose
`project.md` file is missing.

Goal: make upgrade transparent. Detect legacy files on first dashboard /
CLI access, rename them to the v0.2.0+ names, and tolerate the renamed-but-
not-migrated frontmatter fields in the parser as a belt-and-suspenders
fallback. Idempotent. Silent when nothing to do.

## Scope

In:
- Rename `<projectsDir>/<slug>/mission.md` → `<projectsDir>/<slug>/project.md`
  when `mission.md` exists and `project.md` does not.
- Parser tolerance: accept `mission:` in frontmatter as an alias for
  `project:` when parsing project-adjacent files (manifest.md, _index-*.md,
  _status.md, resources/_index.md, memories/_index.md, assignment.md).
- Config migration: if `~/.syntaur/config.md` frontmatter has
  `defaultMissionDir` but not `defaultProjectDir`, rename the field. If it
  points at `~/.syntaur/missions` and that dir exists but
  `~/.syntaur/projects` doesn't, rename the dir.
- Log a one-line summary of what migrated (once per boot) so users know what
  changed.

Out of scope:
- Rewriting `mission:` → `project:` inside user files (parser aliasing is
  enough; non-destructive).
- Deleting stale `agent.md` / `claude.md` (user data — leave alone).
- Any non-filesystem terminology cleanup.
- Bidirectional migration (no v0.2.0+ → v0.1.x downgrade path).

## Pre-existing evidence (from real user machine)

`ls ~/.syntaur/projects/ai-chat-v2/` shows:
```
_index-assignments.md  _index-decisions.md  _index-plans.md
_status.md  agent.md  claude.md  manifest.md  mission.md  assignments/
memories/  resources/
```

Missing: `project.md`. Dashboard shows "No projects yet". Confirms root cause.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/utils/fs-migration.ts` | CREATE | `migrateLegacyProjectFiles(projectsDir)` + `migrateLegacyConfig(configPath)` |
| `src/dashboard/parser.ts` | MODIFY | `parseProject` / `parseAssignmentSummary` accept `mission` as alias for `project` |
| `src/dashboard/api.ts` | MODIFY | Call `migrateLegacyProjectFiles(projectsDir)` at the top of `listProjectRecords` (first-access, lazy) |
| `src/utils/config.ts` | MODIFY | `readConfig` calls `migrateLegacyConfig` before parsing |
| `src/dashboard/server.ts` | MODIFY | Call `migrateLegacyProjectFiles` once at server boot so the dashboard doesn't need a first-GET to trigger it |
| `src/__tests__/fs-migration.test.ts` | CREATE | Rename idempotency + parser alias + config rename cases |

## Tasks

### 1. Implement the migration helpers

- **File:** `src/utils/fs-migration.ts` (CREATE)
- **What:** Two exported async functions, both idempotent and safe on missing paths.
  ```ts
  export async function migrateLegacyProjectFiles(projectsDir: string): Promise<{
    renamedProjectFiles: string[];
    legacyExtras: string[];   // agent.md / claude.md still present — reported, not deleted
  }>;

  export async function migrateLegacyConfig(configPath: string): Promise<{
    renamedField: boolean;
    renamedDir: boolean;
  }>;
  ```
- **Behavior (project files):**
  - If `projectsDir` does not exist → `{ renamedProjectFiles: [], legacyExtras: [] }`.
  - For each direct child dir that does not start with `.`:
    - If `<dir>/mission.md` exists AND `<dir>/project.md` does not → `rename(mission.md, project.md)`, push `<dir>/mission.md`.
    - If `<dir>/agent.md` or `<dir>/claude.md` exists → push to `legacyExtras` (no delete, no touch).
- **Behavior (config):**
  - Read the config markdown, extract frontmatter.
  - If frontmatter key `defaultMissionDir` exists and `defaultProjectDir` does not → write `defaultProjectDir` with the same value, remove `defaultMissionDir`, mark `renamedField: true`.
  - If the value resolves to a dir ending in `/missions` and that dir exists, AND the `/projects` sibling does not exist → `rename(…/missions, …/projects)` and update the config value. Mark `renamedDir: true`.
  - Safe on missing config (no-op, both `false`).
- **Verify:** `npx vitest run src/__tests__/fs-migration.test.ts`

### 2. Parser aliases for `mission` ↔ `project`

- **File:** `src/dashboard/parser.ts` (MODIFY)
- **What:** In `parseProject`, when the project slug is being read from frontmatter, fall back to `mission` if `project` isn't present (i.e. an old user-owned file whose frontmatter the migration helper does NOT rewrite). Same for `parseAssignmentSummary` / `parseAssignmentFull` on the `project:` field and any `mission:` holdouts.
  - Use a small helper: `getProjectField(fm) = getField(fm, 'project') ?? getField(fm, 'mission')`.
- **Rationale:** The file rename addresses the scanner-skip bug. The parser alias covers the residual case where the file is named `project.md` (e.g., new install) but frontmatter inside is still `mission: ...` — which can happen if the user ever ran a custom script to rename only the filename.
- **Verify:** `npx vitest run src/__tests__/parser.test.ts` (if exists) + the new fs-migration test will exercise the alias path.

### 3. Wire the filesystem migration into the read path

- **File:** `src/dashboard/api.ts` (MODIFY `listProjectRecords`)
- **What:** At the top of `listProjectRecords`, before the `readdir` call:
  ```ts
  await migrateLegacyProjectFiles(projectsDir);
  ```
  Add a module-level `let migrated = false;` flag so the work happens once per process lifetime (guard against re-scanning on every GET). Reset on dashboard restart.
- **Note:** Keep this synchronous in the control flow — if a file rename fails (e.g. permissions), `migrateLegacyProjectFiles` must swallow per-project errors and continue, returning what it did manage to rename. Never throw out of the read path.
- **Verify:** Existing `listProjects` / dashboard tests still pass with a fixture that has `mission.md` — they should see `project.md` after the call.

### 4. Wire the config migration into readConfig

- **File:** `src/utils/config.ts` (MODIFY)
- **What:** At the top of `readConfig`, before frontmatter parsing:
  ```ts
  await migrateLegacyConfig(configPath);
  ```
  Same once-per-process guard.
- **Verify:** fs-migration test covers.

### 5. Eager migration at dashboard startup

- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:** After resolving `projectsDir` at startup, call `migrateLegacyProjectFiles(projectsDir)` once and log the summary:
  ```
  [syntaur] migrated legacy mission.md → project.md in 17 projects (ai-chat-v2, alert-tools-toolkit, ...). Per-project agent.md / claude.md left as-is (no longer read).
  ```
  If both `renamedProjectFiles` and `legacyExtras` are empty, log nothing.
- **Rationale:** Gives users a visible confirmation their data just migrated, without spamming on steady-state boots.
- **Verify:** Manual run: `node dist/dashboard/server.js` against a sandbox with one mission.md file — startup log should mention the rename.

### 6. Tests

- **File:** `src/__tests__/fs-migration.test.ts` (CREATE)
- **What:** Cover:
  1. `migrateLegacyProjectFiles`: seeds a tmpdir with `projA/mission.md`, `projB/project.md`, `projC/mission.md + project.md` (collision — should leave both untouched); asserts projA renamed, projB untouched, projC untouched, and the returned `renamedProjectFiles` contains only `projA/mission.md`.
  2. Idempotency: calling twice on the same tree makes no further changes on the second call.
  3. `legacyExtras`: seeds `projA/agent.md` and `projA/claude.md`, asserts both are reported and still exist on disk after the call.
  4. Missing `projectsDir`: returns empty arrays, doesn't throw.
  5. `migrateLegacyConfig`: frontmatter with `defaultMissionDir` renames to `defaultProjectDir`; with both already present, no-op.
  6. Dir rename: sandbox has `~/.syntaur/missions` populated and `~/.syntaur/projects` absent; after `migrateLegacyConfig`, dir renamed and config updated.
  7. Parser alias: calling `parseProject` with frontmatter that has only `mission: my-proj` returns slug `my-proj`.
- **Verify:** `npx vitest run src/__tests__/fs-migration.test.ts`

## Verification (end-to-end)

1. `npm run typecheck`
2. `npx vitest run src/__tests__/fs-migration.test.ts`
3. `npm test` (full suite — nothing else should regress)
4. `npm run build`
5. `npm run build:dashboard`
6. Manual smoke: copy a legacy project dir (or generate a fixture with `mission.md` + no `project.md`) under `~/.syntaur/projects/`, run `syntaur dashboard`, confirm:
   - startup log reports the rename
   - dashboard shows the project
   - `ls ~/.syntaur/projects/<slug>/` now has `project.md` and no `mission.md`
   - running `syntaur dashboard` again logs nothing new (idempotent)

## Release notes for 0.3.2

- Auto-migrate legacy `mission.md` → `project.md` at every project root on first dashboard / CLI boot.
- Auto-rename `defaultMissionDir` → `defaultProjectDir` in `~/.syntaur/config.md` and move `~/.syntaur/missions` → `~/.syntaur/projects` if the target is empty.
- Parser now accepts `mission:` as an alias for `project:` in project / assignment frontmatter for the edge case where a user already renamed the file by hand.

## Known limitations (deferred)

- We don't rewrite `mission: <slug>` inside user-owned markdown files. The parser alias makes this tolerable, but a future pass could offer `syntaur doctor --fix` to normalize frontmatter proactively.
- Legacy `agent.md` / `claude.md` at the project root are left in place. They're no longer read by any code, and deleting user files silently is too risky for a migration helper. A future `syntaur doctor` could surface them as warnings.
