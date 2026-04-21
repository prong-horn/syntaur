# Session ID Integrity + Transcript Path Tracking

**Date:** 2026-04-20
**Complexity:** small
**Tech Stack:** TypeScript (ESM, Node >=20), better-sqlite3 11, Commander 13, Express 5, React 19 (Vite), Vitest 3, bash shell hooks

## Objective

Store only real agent-generated session IDs (Claude Code + Codex) in `~/.syntaur/syntaur.db` and record the raw rollout/transcript path alongside each session. Remove all UUID fallbacks so a missing ID fails loudly instead of masking the real source.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/session-db.ts` | MODIFY | Bump schema to v3, add `transcript_path` column, add v2->v3 migration |
| `src/dashboard/agent-sessions.ts` | MODIFY | Extend `SessionRow`, `rowToSession`, `appendSession` with transcript path |
| `src/dashboard/types.ts` | MODIFY | Add `transcriptPath?: string \| null` to `AgentSession` |
| `src/dashboard/api-agent-sessions.ts` | MODIFY | Require `sessionId` (400 if missing), accept `transcriptPath`, drop randomUUID |
| `src/commands/track-session.ts` | MODIFY | Require `--session-id`, add `--transcript-path`, drop randomUUID |
| `src/index.ts` | MODIFY | Use `requiredOption('--session-id ...')`, add `--transcript-path` |
| `src/__tests__/agent-sessions.test.ts` | MODIFY | Add transcript round-trip, v2->v3 migration, null-transcript cases |
| `platforms/claude-code/hooks/hooks.json` | MODIFY | Register new `SessionStart` hook |
| `platforms/claude-code/hooks/session-start.sh` | CREATE | Capture `session_id` + `transcript_path` into `.syntaur/context.json` |
| `platforms/claude-code/hooks/session-cleanup.sh` | MODIFY | Remove `uuidgen` fallback; exit 0 if no real sessionId |
| `platforms/claude-code/commands/track-session/track-session.md` | MODIFY | Read IDs from context.json, pass `--session-id` + `--transcript-path` |
| `platforms/claude-code/skills/grab-assignment/SKILL.md` | MODIFY | Prefer context.json; extract + pass `--transcript-path` |
| `platforms/claude-code/.claude-plugin/plugin.json` | MODIFY | Bump version |
| `platforms/codex/skills/grab-assignment/SKILL.md` | MODIFY | Replace UUID generation with real rollout-file lookup |
| `platforms/codex/agents/syntaur-operator.md` | MODIFY | Update CLI examples with required flags |
| `platforms/codex/scripts/resolve-session.sh` | CREATE | Helper to find newest rollout matching cwd; emit id + path |
| `platforms/codex/.codex-plugin/plugin.json` | MODIFY | Bump version |
| `dashboard/src/types.ts` | MODIFY | Mirror `transcriptPath` on client `AgentSession` |
| `dashboard/src/pages/AgentSessionsPage.tsx` | MODIFY | Surface transcript path (searchable + visible) |

## Tasks

### 1. Extend DB schema with transcript_path
- **File:** `src/dashboard/session-db.ts` (MODIFY)
- **What:** Bump `SCHEMA_VERSION` to `'3'`. Add `transcript_path TEXT` to `SCHEMA_SQL` (after `description`). Add a v2->v3 migration block mirroring the existing v1->v2 pattern: create `sessions_v2` with the new column, `INSERT INTO sessions_v2 SELECT ..., NULL FROM sessions`, drop/rename, recreate the three indexes, set `schema_version = '3'`.
- **Pattern:** Copy the v1->v2 block at lines 51-79 exactly; substitute the new column.
- **Verify:** `npm run typecheck`

### 2. Thread transcript_path through agent-sessions DAL
- **File:** `src/dashboard/agent-sessions.ts` (MODIFY)
- **What:** Add `transcript_path: string | null` to `SessionRow`. Map it into `rowToSession` as `transcriptPath: row.transcript_path ?? null`. Update `appendSession` INSERT to include the new column and parameter.
- **Pattern:** Follow existing `description` plumbing throughout this file.
- **Verify:** `npm run typecheck`

### 3. Add transcriptPath to shared type
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `transcriptPath?: string | null` to `AgentSession` (after `description`).
- **Verify:** `npm run typecheck`

### 4. Require sessionId + accept transcriptPath at API
- **File:** `src/dashboard/api-agent-sessions.ts` (MODIFY)
- **What:** Destructure `transcriptPath` from `req.body`. If `!sessionId`, return 400 `{ error: 'sessionId is required' }`. Remove the `const id = sessionId || randomUUID()` fallback and the `randomUUID` import. Pass `transcriptPath: transcriptPath || null` into the session object sent to `appendSession`.
- **Verify:** `npm run typecheck`

### 5. Require --session-id + add --transcript-path at CLI
- **File:** `src/commands/track-session.ts` (MODIFY)
- **What:** Add `transcriptPath?: string` to `TrackSessionOptions`. Remove the `sessionId || randomUUID()` fallback and the `randomUUID` import. If `!options.sessionId`, throw `Error('--session-id <id> is required.')`. Pass `transcriptPath: options.transcriptPath ?? null` into `appendSession`.
- **File:** `src/index.ts` (MODIFY, lines 417-437)
- **What:** Change `--session-id` to `.requiredOption('--session-id <id>', ...)`. Add `.option('--transcript-path <path>', 'Path to agent rollout/transcript file')`.
- **Verify:** `npm run typecheck && node dist/index.js track-session --agent claude` should exit non-zero with a clear error about session-id.

### 6. Tests: transcript round-trip + v2->v3 migration
- **File:** `src/__tests__/agent-sessions.test.ts` (MODIFY)
- **What:** Add three cases:
  - `appendSession` stores and retrieves `transcriptPath` on a round-trip.
  - Omitted `transcriptPath` is returned as `null`.
  - v2->v3 migration: open a fresh db, manually create a v2 `sessions` table + `schema_version = '2'` row with seed data, `resetSessionDb()`, `initSessionDb(dbPath)`, assert the seed rows still list correctly and now expose `transcriptPath: null`.
- **Pattern:** Existing `makeSession` + `beforeEach` fixture at lines 23-41.
- **Verify:** `npx vitest run src/__tests__/agent-sessions.test.ts`

### 7. Add Claude Code SessionStart hook
- **File:** `platforms/claude-code/hooks/session-start.sh` (CREATE)
- **What:** Read stdin JSON, extract `session_id`, `transcript_path`, `cwd`. If `cwd` present, ensure `$cwd/.syntaur/` exists, then merge (not overwrite) `{sessionId, transcriptPath}` into `.syntaur/context.json` via `jq --arg sid ... --arg tp ... '. + {sessionId:$sid, transcriptPath:$tp}'`. If context.json absent, create `{ "sessionId": "...", "transcriptPath": "..." }`. Always `exit 0`. Skip gracefully if `jq` absent.
- **Pattern:** Match `platforms/claude-code/hooks/session-cleanup.sh` shell style (shebang, `set -o pipefail 2>/dev/null || true`, jq gate, stdin read).
- **File:** `platforms/claude-code/hooks/hooks.json` (MODIFY)
- **What:** Add a `SessionStart` entry mirroring the existing `SessionEnd` block, pointing at `session-start.sh` with `"timeout": 5`.
- **Verify:** `bash -n platforms/claude-code/hooks/session-start.sh`

### 8. Strip uuidgen fallback from SessionEnd cleanup
- **File:** `platforms/claude-code/hooks/session-cleanup.sh` (MODIFY, lines 39-61)
- **What:** Replace the auto-register block. If `SESSION_ID` is still empty after reading context.json, also try `jq -r '.session_id // empty'` on the stdin `$INPUT`. If still empty, `exit 0` (do NOT uuidgen). Drop the auto-register POST path entirely for this pass — track-session and SessionStart now own registration. Preserve the PATCH `/status` call at the end.
- **Verify:** `bash -n platforms/claude-code/hooks/session-cleanup.sh`

### 9. Update /track-session slash command
- **File:** `platforms/claude-code/commands/track-session/track-session.md` (MODIFY)
- **What:** In Step 2, before invoking the CLI, read `.syntaur/context.json` (populated by SessionStart) and extract `sessionId` and `transcriptPath`. If `sessionId` is absent, instruct the model to fail with a clear error. Update the bash example to include `--session-id <id> --transcript-path <path>`. In Step 3, drop the "extract session ID from output" logic since we now supply it.
- **Verify:** Read-through review — no executable check.

### 10. Update Claude grab-assignment skill
- **File:** `platforms/claude-code/skills/grab-assignment/SKILL.md` (MODIFY, lines 143-160)
- **What:** In Step 5.5, reorder source-of-truth: prefer reading `sessionId` + `transcriptPath` from `.syntaur/context.json` when present (SessionStart hook path). Fall back to `~/.claude/sessions/*.json` only if absent, and in that case also derive transcript_path from the same file (or leave null if unavailable). Update the bash example to `syntaur track-session --project ... --assignment ... --agent claude --session-id <id> --transcript-path <path> --path $(pwd)`.
- **Verify:** Read-through.

### 11. Bump Claude plugin version
- **File:** `platforms/claude-code/.claude-plugin/plugin.json` (MODIFY)
- **What:** Bump `version` from `0.1.7` to `0.1.8`.

### 12. Codex: real session-id extraction helper
- **File:** `platforms/codex/scripts/resolve-session.sh` (CREATE)
- **What:** Bash helper that: finds newest file under `~/.codex/sessions/*/*/*/rollout-*.jsonl`, reads the first line with `jq`, filters where `.payload.cwd == $PWD`, picks the most recent, and prints two lines: `session_id=<id>` and `transcript_path=<absolute path>`. Emit nothing (exit non-zero) if no match. Script is read by callers with `eval` or line-parse. Guarded on `command -v jq`.
- **Pattern:** Match codex shell style in `platforms/codex/scripts/session-cleanup.sh` (shebang, `set -o pipefail 2>/dev/null || true`, jq gate).
- **Verify:** `bash -n platforms/codex/scripts/resolve-session.sh`

### 13. Update Codex grab-assignment skill
- **File:** `platforms/codex/skills/grab-assignment/SKILL.md` (MODIFY, lines 57-59)
- **What:** Replace Step 9 "generate a UUID" guidance with: run `bash ${CODEX_PLUGIN_ROOT}/scripts/resolve-session.sh` (or inline equivalent — match how other Codex scripts are referenced in this repo). Parse `session_id` and `transcript_path` from its output, store both in `.syntaur/context.json`, then run `syntaur track-session --project <p> --assignment <a> --agent codex --session-id <id> --transcript-path <path> --path <cwd>`. Also update Step 8's JSON example to include `transcriptPath`.
- **Verify:** Read-through.

### 14. Update Codex operator agent prompt
- **File:** `platforms/codex/agents/syntaur-operator.md` (MODIFY)
- **What:** Update line 96 CLI example to `syntaur track-session --project <project-slug> --assignment <assignment-slug> --agent codex --session-id <id> --transcript-path <rollout-path> --path <cwd>`. Update Step 5 of "Claim an assignment" (line 107) to note that session ID must come from the newest matching rollout file, not a generated UUID. Remove any lingering UUID guidance.
- **Verify:** Read-through.

### 15. Bump Codex plugin version
- **File:** `platforms/codex/.codex-plugin/plugin.json` (MODIFY)
- **What:** Bump `version` from `0.1.7` to `0.1.8`.

### 16. Dashboard client: mirror type + surface column
- **File:** `dashboard/src/types.ts` (MODIFY, lines 69-79)
- **What:** Add `transcriptPath?: string | null` to client `AgentSession`. Keep in sync with `src/dashboard/types.ts`.
- **File:** `dashboard/src/pages/AgentSessionsPage.tsx` (MODIFY, lines 93-104)
- **What:** Append `session.transcriptPath ?? ''` to the `haystack` array. Add a compact UI affordance for transcript path — a truncated monospace span with `title={session.transcriptPath}` tooltip and a copy-to-clipboard button, placed alongside the existing session path rendering. Leave layout patterns consistent with the surrounding column structure.
- **Verify:** `npm run typecheck && npm run build:dashboard`

## Dependencies

- None external. `better-sqlite3` migration is in-process.
- No env vars introduced.
- Existing synthetic UUID rows remain (out of scope for purge per user).

## Verification

- `npm run typecheck`
- `npx vitest run src/__tests__/agent-sessions.test.ts`
- `npm test`
- `npm run build`
- `npm run build:dashboard`
- `bash -n platforms/claude-code/hooks/session-start.sh platforms/claude-code/hooks/session-cleanup.sh platforms/codex/scripts/resolve-session.sh`
- Manual smoke: delete local DB, run `syntaur track-session --agent claude` (should error on missing --session-id); re-run with `--session-id <real> --transcript-path <path>` (should insert); inspect row via `sqlite3 ~/.syntaur/syntaur.db "SELECT session_id, transcript_path FROM sessions ORDER BY started DESC LIMIT 1;"`.
