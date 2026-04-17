# GitHub Backup/Import Feature

**Date:** 2026-04-16
**Complexity:** small
**Tech Stack:** TypeScript, Node.js, Express 5, Commander CLI, React 18 + Tailwind CSS

## Objective
Allow users to back up their Syntaur files (missions, playbooks, todos, servers, config) to a GitHub repository and restore from it. Manual trigger only (CLI command + dashboard button). Files only, no SQLite. Users configure which file categories are included.

## Codex Review Issues (Resolved)

1. **Assignments aren't top-level** — They're nested under missions, not `~/.syntaur/assignments/`. Removed `assignments` as a standalone category; they're included when `missions` is selected.
2. **Missions dir is configurable** — `readConfig().defaultMissionDir` may differ from `~/.syntaur/missions/`. Backup must resolve paths from config, not hardcode.
3. **Wrong CLI pattern** — Use `todoCommand` grouped-command pattern (`new Command('backup')` + `program.addCommand()`), not `create-mission.ts` single-action pattern.
4. **Config parser doesn't handle arrays** — Store `backup.categories` as a comma-separated string (e.g., `missions, playbooks, todos`), parsed to `string[]` in code. Matches how the frontmatter parser works (scalar values only).
5. **Missing error handling** — Added explicit handling for: git not installed, auth failures, non-fast-forward push, empty commit/no-op, partial restore.
6. **Restore semantics** — Restore overwrites local files with repo versions for selected categories only. Config (`config.md`) is never overwritten on restore (would clobber backup settings). User's current `workspaces.json` is preserved.
7. **Concurrency** — Add a simple file-lock (PID file) to prevent simultaneous push/pull.
8. **Validation** — Validate repo URL format and category values in both CLI and API.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/utils/github-backup.ts` | CREATE | Core backup/restore logic using git CLI |
| `src/utils/config.ts` | MODIFY | Add `BackupConfig` interface to `SyntaurConfig` |
| `src/templates/config.ts` | MODIFY | Replace `sync:` stub with `backup:` section |
| `src/commands/backup.ts` | CREATE | CLI `backup push` / `backup pull` / `backup config` subcommands |
| `src/index.ts` | MODIFY | Register backup command via `program.addCommand()` |
| `src/dashboard/api-backup.ts` | CREATE | Express router for backup/restore API endpoints |
| `src/dashboard/server.ts` | MODIFY | Mount backup router |
| `dashboard/src/pages/SettingsPage.tsx` | MODIFY | Add GitHub Backup `SectionCard` |
| `src/__tests__/github-backup.test.ts` | CREATE | Unit tests for backup utility functions |

## Tasks

### 1. Define BackupConfig and extend SyntaurConfig
- **File:** `src/utils/config.ts` (MODIFY)
- **What:**
  - Add `BackupConfig` interface: `repo: string | null`, `categories: string` (comma-separated: "missions, playbooks, todos, servers, config"), `lastBackup: string | null`, `lastRestore: string | null`
  - Add `backup: BackupConfig | null` to `SyntaurConfig` interface (line 41)
  - Add to `DEFAULT_CONFIG` (line 53): `backup: null`
  - In `readConfig()` (line 442): parse `backup.repo`, `backup.categories`, `backup.lastBackup`, `backup.lastRestore` from frontmatter using existing dot-notation pattern
  - Add `serializeBackupConfig()` following `serializeIntegrationConfig()` pattern (line 243)
  - Add `updateBackupConfig()` following `updateIntegrationConfig()` pattern (line 380): read existing config, merge, strip old `backup:` block via `stripTopLevelBlock`, write back
- **Valid categories:** `missions`, `playbooks`, `todos`, `servers`, `config`
- **Pattern:** `IntegrationConfig` / `updateIntegrationConfig` at `config.ts:31-35` and `config.ts:380-410`
- **Verify:** `npx vitest run --reporter=verbose` (existing config tests still pass)

### 2. Update config template
- **File:** `src/templates/config.ts` (MODIFY)
- **What:** Replace the `sync:` section (lines 14-17) with:
  ```
  backup:
    repo: null
    categories: missions, playbooks, todos, servers, config
    lastBackup: null
    lastRestore: null
  ```
- **Pattern:** Existing `renderConfig` function
- **Verify:** Template renders correctly

### 3. Create core backup/restore utility
- **File:** `src/utils/github-backup.ts` (CREATE)
- **What:**
  - `const exec = promisify(execFile)` — same pattern as `src/dashboard/scanner.ts:1-19`
  - `VALID_CATEGORIES = ['missions', 'playbooks', 'todos', 'servers', 'config']`
  - Category-to-path mapping resolves dynamically:
    - `missions` → `readConfig().defaultMissionDir` (NOT hardcoded `~/.syntaur/missions/`)
    - `playbooks` → `playbooksDir()` from `paths.ts`
    - `todos` → `todosDir()` from `paths.ts`
    - `servers` → `serversDir()` from `paths.ts`
    - `config` → `syntaurRoot()/config.md` (single file, not a dir)
  - `backupToGithub(config: BackupConfig)`:
    1. Validate repo is set, categories are valid
    2. Check `git` is installed (`exec('git', ['--version'])`, catch → throw "git is not installed")
    3. Create temp dir, clone repo (or init if empty), copy selected category dirs/files into it
    4. `git add -A`, check if anything changed (`git status --porcelain`), skip commit if empty
    5. `git commit`, `git push` (catch non-fast-forward → throw descriptive error)
    6. Clean up temp dir
    7. Update `lastBackup` timestamp via `updateBackupConfig()`
  - `restoreFromGithub(config: BackupConfig)`:
    1. Validate repo, categories
    2. Clone repo to temp dir
    3. Copy files back to local paths for selected categories
    4. **Never overwrite `config.md`** (would clobber backup settings) — skip or merge
    5. Update `lastRestore` timestamp
    6. Clean up temp dir
  - `validateRepoUrl(url: string): boolean` — basic validation (starts with `https://` or `git@`)
  - `validateCategories(cats: string[]): string[]` — filter to VALID_CATEGORIES, warn on unknown
  - File lock: write a `.backup-lock` PID file in `syntaurRoot()` before operations, remove after. Check on entry, error if locked.
- **Verify:** Unit tests (task 9)

### 4. Create CLI backup command
- **File:** `src/commands/backup.ts` (CREATE)
- **What:** Export `backupCommand` as `new Command('backup')` with subcommands:
  - `backup push` — runs `backupToGithub`. Options: `--repo <url>` (override), `--categories <list>` (comma-separated override)
  - `backup pull` — runs `restoreFromGithub`. Same options.
  - `backup config` — display current backup config (repo, categories, last timestamps)
- **Pattern:** Follow `todoCommand` in `src/commands/todo.ts:36-46` — `new Command('backup')` with chained `.command()` subcommands
- **Error handling:** try/catch with `process.exit(1)`, print user-friendly messages for: no repo configured, git not found, auth failure, push rejected
- **Verify:** `npx syntaur backup --help` shows subcommands

### 5. Register CLI command
- **File:** `src/index.ts` (MODIFY)
- **What:**
  - Add import: `import { backupCommand } from './commands/backup.js';` (after line 23)
  - Add registration: `program.addCommand(backupCommand);` (after line 436, next to `todoCommand`)
- **Pattern:** Same as `program.addCommand(todoCommand)` at `index.ts:436`
- **Verify:** `npx syntaur --help` shows `backup` command

### 6. Create backup API router
- **File:** `src/dashboard/api-backup.ts` (CREATE)
- **What:** Export `createBackupRouter()` returning an Express `Router`:
  - `GET /` — return backup config + status (repo, categories, lastBackup, lastRestore)
  - `POST /push` — trigger backup, return `{ success: true, timestamp }` or `{ error: string }`
  - `POST /pull` — trigger restore, return same shape
  - `PUT /config` — update backup config (repo URL + categories). Validate: repo URL format, categories against VALID_CATEGORIES. Return 400 for invalid input.
- **Pattern:** Follow `createServersRouter` in `src/dashboard/api-servers.ts:17` — exported factory function returning `Router`
- **Verify:** `curl http://localhost:4400/api/backup` returns config

### 7. Mount backup router in server
- **File:** `src/dashboard/server.ts` (MODIFY)
- **What:**
  - Add import: `import { createBackupRouter } from './api-backup.js';` (after line 28)
  - Mount: `app.use('/api/backup', createBackupRouter());` (after line 299, after todos router)
- **Pattern:** Same as `app.use('/api/todos', createTodosRouter(todosDir, broadcast))` at `server.ts:299`
- **Verify:** Dashboard server starts without errors

### 8. Add GitHub Backup section to Settings page
- **File:** `dashboard/src/pages/SettingsPage.tsx` (MODIFY)
- **What:** Add a new `SectionCard` titled "GitHub Backup" after the existing status config section:
  - Text input for repo URL
  - Checkbox list for categories (missions, playbooks, todos, servers, config)
  - "Save Config" button → `PUT /api/backup/config`
  - "Back Up Now" button → `POST /api/backup/push` (disabled while running, show spinner)
  - "Restore" button → `POST /api/backup/pull` (with confirmation dialog — "This will overwrite local files for selected categories")
  - Display last backup/restore timestamps
  - Inline success/error feedback banner (same pattern as existing save feedback at `SettingsPage.tsx:50`)
- **State:** Separate `useState` hooks for backup config (independent from status config dirty tracking). Don't merge into the existing save flow.
- **Pattern:** Follow existing `SectionCard` usage in SettingsPage
- **Verify:** Dashboard settings page loads, backup card renders, buttons trigger API calls

### 9. Write unit tests
- **File:** `src/__tests__/github-backup.test.ts` (CREATE)
- **What:**
  - Test `validateRepoUrl`: valid https, valid git@, invalid strings
  - Test `validateCategories`: valid list, unknown categories filtered, empty list
  - Test category-to-path mapping resolves correctly from config
  - Test config serialization/parsing round-trip for backup fields
  - Mock `execFile` to verify correct git commands are constructed for push/pull
  - Test edge cases: no repo configured (throws), empty categories (throws), lock file prevents concurrent ops
- **Pattern:** Follow existing test files in `src/__tests__/`
- **Verify:** `npx vitest run src/__tests__/github-backup.test.ts`

## Dependencies
- No new npm packages (uses `child_process.execFile` for git, already in codebase)
- Requires `git` CLI installed on the user's machine
- User must have push access to the configured GitHub repo (SSH key or credential helper)

## Verification
- `npm run build` compiles without errors
- `npx vitest run` all tests pass
- `npx syntaur backup --help` shows push/pull/config subcommands
- Dashboard settings page loads and displays backup card
- Full round-trip: configure repo in UI, click "Back Up Now", verify files appear in GitHub repo, click "Restore" on a clean `~/.syntaur/` to verify restore
