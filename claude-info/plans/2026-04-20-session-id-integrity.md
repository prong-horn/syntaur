# Session ID Integrity + Transcript Path Tracking

**Date:** 2026-04-20
**Complexity:** small
**Tech Stack:** TypeScript (ESM, Node >=20), better-sqlite3 11, Commander 13, Express 5, React 19 (Vite), Vitest 3, bash shell hooks
**Revision:** v4 (post third codex plan review)

## Objective

Store only real agent-generated session IDs (Claude Code + Codex) in `~/.syntaur/syntaur.db`, and record the raw rollout/transcript path alongside each session. Remove all UUID fallbacks so a missing ID fails loudly instead of silently synthesizing one.

## Constraints from codex plan review (resolved in this revision)

- **SessionStart must not create stray context files.** The Claude SessionStart hook MUST only merge into an existing `.syntaur/context.json` — never create one. This preserves `grab-assignment`'s existing "context.json implies active assignment" semantic (`platforms/claude-code/skills/grab-assignment/SKILL.md:29`).
- **Caller-side migration must land before fallback removal.** The SessionEnd cleanup hook retains the auto-register path through all slash-command / skill / expert-agent updates, and only loses its `uuidgen` fallback AFTER every caller has been updated.
- **Duplicate real-session-id inserts must not 500.** `appendSession` becomes an upsert (`INSERT ... ON CONFLICT(session_id) DO UPDATE SET ...`) so SessionStart can pre-register a minimal row that grab-assignment/track-session later enrich with project/assignment/description.
- **Codex scripts are referenced by relative path**, matching `platforms/codex/hooks.json:9,20` (`./scripts/<name>.sh`). No `${CODEX_PLUGIN_ROOT}`.
- **Concurrent Codex sessions in the same cwd is a documented known limitation** for this pass — resolver picks the newest rollout whose `payload.cwd` matches; if users hit this edge case, they can manually pass `--session-id` + `--transcript-path`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/dashboard/session-db.ts` | MODIFY | Bump schema to v3, add `transcript_path` column, v2→v3 migration |
| `src/dashboard/agent-sessions.ts` | MODIFY | Extend `SessionRow`/`rowToSession`/`appendSession`; upsert semantics |
| `src/dashboard/types.ts` | MODIFY | Add `transcriptPath?: string \| null` to `AgentSession` |
| `src/dashboard/api-agent-sessions.ts` | MODIFY | Require `sessionId` (400 if missing), accept `transcriptPath`, drop randomUUID |
| `src/dashboard/help.ts` | MODIFY | Update CLI help example to include `--session-id` + `--transcript-path` |
| `src/commands/track-session.ts` | MODIFY | Require `--session-id`, add `--transcript-path`, drop randomUUID |
| `src/index.ts` | MODIFY | Use `requiredOption('--session-id ...')`, add `--transcript-path` |
| `src/__tests__/agent-sessions.test.ts` | MODIFY | Round-trip, v2→v3 migration, upsert-on-conflict, null transcript cases |
| `src/__tests__/commands.test.ts` | MODIFY (or CREATE if absent) | CLI rejects missing `--session-id` |
| `src/__tests__/dashboard-api.test.ts` | MODIFY | POST /api/agent-sessions returns 400 when sessionId missing |
| `platforms/claude-code/agents/syntaur-expert.md` | MODIFY | Update CLI example (line 194), hook table (line 239), context example (line 384) |
| `platforms/claude-code/skills/grab-assignment/SKILL.md` | MODIFY | Merge-not-overwrite context.json; extract session_id + transcript_path; `--transcript-path` flag |
| `platforms/claude-code/commands/track-session/track-session.md` | MODIFY | Read IDs from context.json; pass both flags; fail cleanly if missing |
| `platforms/claude-code/hooks/hooks.json` | MODIFY | Register new `SessionStart` hook |
| `platforms/claude-code/hooks/session-start.sh` | CREATE | Merge `sessionId` + `transcriptPath` into EXISTING `.syntaur/context.json`; no create |
| `platforms/claude-code/hooks/session-cleanup.sh` | MODIFY | Remove `uuidgen` fallback block (lands LAST) |
| `platforms/claude-code/.claude-plugin/plugin.json` | MODIFY | Bump version |
| `platforms/codex/skills/grab-assignment/SKILL.md` | MODIFY | Replace UUID generation with real rollout-file lookup; merge into context.json |
| `platforms/codex/agents/syntaur-operator.md` | MODIFY | Update CLI examples with required flags; drop UUID guidance |
| `platforms/codex/scripts/resolve-session.sh` | CREATE | Find newest rollout matching `$PWD`; emit `session_id=<id>\ntranscript_path=<path>` |
| `platforms/codex/.codex-plugin/plugin.json` | MODIFY | Bump version |
| `src/__tests__/hook-session-start.test.ts` | CREATE | Spawn `bash session-start.sh` with fixture stdin/tmpdir and assert merge behavior |
| `src/__tests__/codex-resolve-session.test.ts` | CREATE | Spawn `bash resolve-session.sh` with a `CODEX_SESSIONS_DIR` override pointing at a fixture rollout; assert emitted `session_id=` and `transcript_path=` lines |
| `dashboard/src/types.ts` | MODIFY | Mirror `transcriptPath` on client `AgentSession` |
| `dashboard/src/pages/AgentSessionsPage.tsx` | MODIFY | Surface transcript path (searchable + visible + copy) |
| `docs/protocol/file-formats.md` | MODIFY | Document new `transcript_path` column + rule "session_id must be agent-generated" |

## Tasks

Ordered to keep callers ahead of fallback removal.

### 1. Extend DB schema with transcript_path

- **File:** `src/dashboard/session-db.ts` (MODIFY)
- **What:** Bump `SCHEMA_VERSION` from `'2'` → `'3'`. Add `transcript_path TEXT` to `SCHEMA_SQL` (after the `description` column). Add a v2→v3 migration block mirroring the v1→v2 pattern at lines 51–79 exactly:
  - Create `sessions_v3` with the new column.
  - `INSERT INTO sessions_v3 SELECT session_id, project_slug, assignment_slug, agent, started, ended, status, path, description, NULL, created_at, updated_at FROM sessions;`
  - `DROP TABLE sessions; ALTER TABLE sessions_v3 RENAME TO sessions;`
  - Recreate the three existing indexes (project, assignment, status).
  - `UPDATE meta SET value = '3' WHERE key = 'schema_version';`
- **Pattern:** Identical structure to v1→v2 block.
- **Verify:** `npm run typecheck`

### 2. Thread transcript_path + upsert semantics through agent-sessions DAL

- **File:** `src/dashboard/agent-sessions.ts` (MODIFY)
- **What:**
  - Add `transcript_path: string | null` to `SessionRow`.
  - Map `transcriptPath: row.transcript_path ?? null` in `rowToSession`.
  - Rewrite `appendSession` INSERT to be an upsert:
    ```sql
    INSERT INTO sessions (session_id, project_slug, assignment_slug, agent, started, status, path, description, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_slug    = COALESCE(excluded.project_slug,    project_slug),
      assignment_slug = COALESCE(excluded.assignment_slug, assignment_slug),
      agent           = excluded.agent,
      status          = CASE WHEN status IN ('completed','stopped') THEN status ELSE excluded.status END,
      path            = COALESCE(excluded.path,            path),
      description     = COALESCE(excluded.description,     description),
      transcript_path = COALESCE(excluded.transcript_path, transcript_path),
      updated_at      = datetime('now')
    ```
  - Update JSDoc on `appendSession` to note it is now an upsert keyed on `session_id`, and that re-registering a terminal session does NOT revive it.
- **Verify:** `npm run typecheck`

### 3. Add transcriptPath to shared server type

- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `transcriptPath?: string | null` to `AgentSession` (after `description`).
- **Verify:** `npm run typecheck`

### 4. Update CLI help metadata

- **File:** `src/dashboard/help.ts` (MODIFY, the `syntaur track-session` entry around line 104–108)
- **What:** Update the `example` to `'syntaur track-session --agent claude --session-id <real-id> --transcript-path <path> --project ui-overhaul --assignment implement-overview'`. Update `description` to note `--session-id` is required.
- **Verify:** `npm run typecheck`

### 5. Require sessionId + accept transcriptPath at API

- **File:** `src/dashboard/api-agent-sessions.ts` (MODIFY)
- **What:**
  - Destructure `transcriptPath` from `req.body`.
  - If `!sessionId`, return `res.status(400).json({ error: 'sessionId is required' })`.
  - Remove the `const id = sessionId || randomUUID()` line — use `sessionId` directly.
  - Remove the `randomUUID` import (line 3).
  - Pass `transcriptPath: transcriptPath || null` into the session object sent to `appendSession`.
  - Response body continues to return `{ sessionId }`.
- **Verify:** `npm run typecheck`

### 6. Require --session-id + add --transcript-path at CLI

- **File:** `src/commands/track-session.ts` (MODIFY)
- **What:**
  - Add `transcriptPath?: string` to `TrackSessionOptions`.
  - Remove the `const sessionId = options.sessionId || randomUUID()` line; use `options.sessionId` directly.
  - Remove the `randomUUID` import.
  - Before the `await appendSession(...)` call, if `!options.sessionId`, throw `new Error('--session-id <id> is required. Real agent session IDs only — no auto-generation.')`.
  - Pass `transcriptPath: options.transcriptPath ?? null` through `appendSession`.
- **File:** `src/index.ts` (MODIFY, lines 417–437)
- **What:**
  - Change `.option('--session-id <id>', 'Session ID (auto-generated if omitted)')` to `.requiredOption('--session-id <id>', 'Session ID from the agent runtime (real, not generated)')`.
  - Add `.option('--transcript-path <path>', 'Absolute path to the agent rollout/transcript file')`.
- **Verify:** `npm run build && node dist/index.js track-session --agent claude 2>&1 | grep -i "required.*session-id"` exits with `commander`-style error.

### 7. Tests: DAL round-trip + v2→v3 migration + upsert

- **File:** `src/__tests__/agent-sessions.test.ts` (MODIFY)
- **What:** Add four cases using the existing `mkdtemp` + `resetSessionDb()` + `initSessionDb(dbPath)` fixture:
  1. `appendSession` round-trips `transcriptPath`.
  2. `appendSession` with omitted `transcriptPath` yields `null` on read.
  3. v2→v3 migration: create a fresh sqlite db at the test path; write the v2 schema manually (`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, project_slug TEXT, assignment_slug TEXT, agent TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, status TEXT NOT NULL DEFAULT 'active', path TEXT, description TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))` + `INSERT INTO meta (key, value) VALUES ('schema_version', '2')`); seed 2 rows; call `resetSessionDb()` + `initSessionDb(dbPath)`; assert rows still list + now surface `transcriptPath: null` + `PRAGMA table_info(sessions)` includes `transcript_path`.
  4. Upsert semantics: `appendSession` twice with the same `sessionId`, second call has `projectSlug='p1'` + `transcriptPath='/tmp/t.jsonl'` but first call omitted both; assert after the second insert the row shows `projectSlug='p1'` + `transcriptPath='/tmp/t.jsonl'` and the `started` field from the first call is preserved.
- **Verify:** `npx vitest run src/__tests__/agent-sessions.test.ts`

### 8. Tests: CLI rejects missing --session-id (real Commander parsing)

- **File:** `src/__tests__/commands.test.ts` (MODIFY — add a new `describe('track-session CLI required flags')` block)
- **What:** This test must exercise Commander's required-option enforcement, not just the bare function. Two cases:
  1. `trackSessionCommand({ agent: 'claude' })` rejects with an Error whose message contains `session-id` (covers the in-function guard).
  2. Spawn the built CLI in a subprocess. The test file is ESM (`"type": "module"` in `package.json`), so derive the current dir from `import.meta.url` rather than `__dirname`:
     ```ts
     import { fileURLToPath } from 'node:url';
     import { dirname, resolve } from 'node:path';
     import { spawnSync } from 'node:child_process';
     const here = dirname(fileURLToPath(import.meta.url));
     const cliPath = resolve(here, '../../dist/index.js');
     const res = spawnSync('node', [cliPath, 'track-session', '--agent', 'claude'], { encoding: 'utf-8' });
     expect(res.status).not.toBe(0);
     expect(res.stderr).toMatch(/session-id/);
     ```
- **Build dependency:** The subprocess case requires `dist/index.js` to exist. Add a `beforeAll` that runs `execSync('npm run build', { stdio: 'inherit' })` IF `dist/index.js` is absent. Alternative (preferred if faster): use `tsx` if already a dev dep — grep `package.json` to confirm; if yes, spawn `npx tsx src/index.ts ...` directly. Use whichever the repo already supports.
- **Verify:** `npm run build && npx vitest run src/__tests__/commands.test.ts`

### 8a. Test: Claude SessionStart hook merge behavior

- **File:** `src/__tests__/hook-session-start.test.ts` (CREATE)
- **What:** Using Vitest + `node:child_process` `spawnSync`, verify the hook script's contract end-to-end:
  1. Setup: `mkdtemp` a tmpdir, create `<tmp>/.syntaur/context.json` seeded with `{"projectSlug":"p","assignmentSlug":"a"}`.
  2. `spawnSync('bash', [resolve(repoRoot, 'platforms/claude-code/hooks/session-start.sh')], { input: JSON.stringify({ session_id: 'abc-123', transcript_path: '/tmp/t.jsonl', cwd: tmpdir }), encoding: 'utf-8' })`.
  3. Assert exit status 0 and that `<tmp>/.syntaur/context.json` now contains `sessionId: 'abc-123'`, `transcriptPath: '/tmp/t.jsonl'`, AND preserves the original `projectSlug` + `assignmentSlug`.
  4. Second case: empty tmpdir with NO `.syntaur/` directory; run the hook with the same stdin; assert exit 0 and that no `.syntaur/` directory was created (the "never create" invariant).
  5. Third case: transcript_path empty string; assert merged JSON has `sessionId` but does NOT add a `transcriptPath` key (see the `if ($tp | length) > 0` guard in task 13).
- **Verify:** `npx vitest run src/__tests__/hook-session-start.test.ts`

### 8b. Test: Codex resolve-session.sh against fixture rollout

- **File:** `src/__tests__/codex-resolve-session.test.ts` (CREATE)
- **What:**
  1. `mkdtemp` a tmpdir, inside build `<tmp>/2026/04/20/rollout-2026-04-20T00-00-00-abc123.jsonl` whose first line is `{"type":"session_meta","payload":{"id":"019d8738-1168-7040-9a75-f6b5573959af","cwd":"/fake/cwd"}}`.
  2. `spawnSync('bash', [resolve(repoRoot, 'platforms/codex/scripts/resolve-session.sh'), '/fake/cwd'], { env: { ...process.env, CODEX_SESSIONS_DIR: tmpdir }, encoding: 'utf-8' })`.
  3. Assert exit 0, stdout contains `session_id=019d8738-1168-7040-9a75-f6b5573959af` and `transcript_path=<tmp>/2026/04/20/rollout-...jsonl`.
  4. Negative case: call with `/different/cwd` — assert non-zero exit, empty stdout.
  5. Multi-file case: write two fixtures for the same `cwd` with different `payload.id`s, touch the newer one last, and assert the resolver emits the newer session_id (mtime ordering check).
- **Verify:** `npx vitest run src/__tests__/codex-resolve-session.test.ts`

### 9. Tests: API POST returns 400 when sessionId missing

- **File:** `src/__tests__/dashboard-api.test.ts` (MODIFY)
- **Harness reality check:** This test file currently exercises the `api.ts` functions directly (no supertest, no mounted Express app). There is no `supertest` dependency in `package.json`. Build a minimal Express harness inside the new test:
  ```ts
  import express from 'express';
  import { createAgentSessionsRouter } from '../dashboard/api-agent-sessions.js';
  import { initSessionDb, closeSessionDb, resetSessionDb } from '../dashboard/session-db.js';

  describe('POST /api/agent-sessions', () => {
    let server: any;
    let port: number;
    beforeEach(async () => {
      resetSessionDb();
      const dbDir = await mkdtemp(join(tmpdir(), 'syntaur-apidb-'));
      initSessionDb(join(dbDir, 'syntaur.db'));
      const app = express();
      app.use(express.json());
      app.use('/api/agent-sessions', createAgentSessionsRouter(dbDir));
      await new Promise<void>((r) => { server = app.listen(0, () => r()); });
      port = (server.address() as any).port;
    });
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      closeSessionDb();
    });

    it('returns 400 when sessionId is missing', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'claude' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/sessionId/);
    });

    it('accepts and persists transcriptPath on successful POST', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agent-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'claude', sessionId: 'abc-123', transcriptPath: '/tmp/t.jsonl' }),
      });
      expect(res.status).toBe(201);
    });
  });
  ```
  Node 20's built-in `fetch` means no extra dep. `resetSessionDb`/`closeSessionDb` already exist per the session-db fixture pattern — if not currently exported, surface them as part of this task.
- **Verify:** `npx vitest run src/__tests__/dashboard-api.test.ts`

### 10. Update Claude grab-assignment skill (pre-flight + merge context)

- **File:** `platforms/claude-code/skills/grab-assignment/SKILL.md` (MODIFY)
- **What:**
  - **Pre-flight (lines 27–31):** Change the "active assignment" heuristic so it warns only if context.json has BOTH `projectSlug` AND `assignmentSlug` set. A context.json that only has `sessionId` / `transcriptPath` (populated by SessionStart) is NOT an active assignment — proceed without warning.
  - **Step 5 (lines 116–139):** Stop unconditional write of context.json. Instead, READ any existing context.json, then MERGE assignment fields (`projectSlug`, `assignmentSlug`, `projectDir`, `assignmentDir`, `workspaceRoot`, `title`, `branch`, `grabbedAt`) on top of it. Preserve `sessionId` and `transcriptPath` if present. Example bash:
    ```bash
    mkdir -p .syntaur
    if [ -f .syntaur/context.json ]; then
      jq --slurpfile new <(echo "$NEW_CONTEXT_JSON") '. + $new[0]' .syntaur/context.json > .syntaur/context.json.tmp \
        && mv .syntaur/context.json.tmp .syntaur/context.json
    else
      echo "$NEW_CONTEXT_JSON" > .syntaur/context.json
    fi
    ```
  - **Step 5.5 (lines 143–160):** Rework source-of-truth for session identification:
    1. If `.syntaur/context.json` already has `sessionId` (SessionStart populated it), use it and read `transcriptPath` too.
    2. Otherwise, fall back to `~/.claude/sessions/*.json` lookup by cwd (existing logic).
    3. If neither yields a real ID, abort with an explicit "run /track-session after restarting your Claude session" error — DO NOT generate a UUID.
    4. After resolving, merge `sessionId` + `transcriptPath` back into context.json.
    5. Update the CLI invocation to:
       ```bash
       syntaur track-session --project <projectSlug> --assignment <assignmentSlug> --agent claude --session-id <real-id> --transcript-path <path> --path $(pwd)
       ```
- **Verify:** Read-through review.

### 11. Update /track-session slash command

- **File:** `platforms/claude-code/commands/track-session/track-session.md` (MODIFY)
- **What:**
  - In **Step 2**, before running the CLI, read `.syntaur/context.json` and extract `sessionId` + `transcriptPath`. If `sessionId` is absent, try the `~/.claude/sessions/*.json` fallback (same as grab-assignment Step 5.5); if still absent, abort with explicit error. Update the bash example to include `--session-id "$SESSION_ID" --transcript-path "$TRANSCRIPT_PATH"`.
  - **Step 3:** Drop the "parse session ID from output" logic — we now supply the ID and the CLI just confirms registration.
  - **Step 4:** Keep the context.json merge (not overwrite) — `jq '. + {sessionId:$sid, transcriptPath:$tp}' <file>`.
- **Verify:** Read-through.

### 12. Update Claude Syntaur expert agent

- **File:** `platforms/claude-code/agents/syntaur-expert.md` (MODIFY)
- **What:**
  - **Line 194:** Change CLI example to `syntaur track-session --project M --assignment A --agent N --session-id <real-id> --transcript-path <path>`.
  - **Line 239 hooks table:** Add a `SessionStart` row: "Claude Code session starts | Runs session-start.sh to merge real session_id + transcript_path into existing `.syntaur/context.json`. Does nothing if context.json is absent."
  - **Line 384 context example:** Change `"sessionId": "uuid-v4"` to `"sessionId": "<real-claude-session-id>"` and add `"transcriptPath": "/Users/you/.claude/projects/<encoded-cwd>/<session-id>.jsonl"`.
- **Verify:** Read-through.

### 13. Add Claude SessionStart hook (merge-only, existing-context-required)

- **File:** `platforms/claude-code/hooks/session-start.sh` (CREATE)
- **What:**
  ```bash
  #!/usr/bin/env bash
  set -o pipefail 2>/dev/null || true
  command -v jq >/dev/null 2>&1 || exit 0
  INPUT=$(cat)
  [ -z "$INPUT" ] && exit 0
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
  TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
  [ -z "$SESSION_ID" ] && exit 0
  [ -z "$CWD" ] && exit 0
  CONTEXT_FILE="$CWD/.syntaur/context.json"
  # REQUIRED: only operate on EXISTING context.json — never create one. This preserves
  # grab-assignment's "context.json implies active assignment" semantic.
  [ ! -f "$CONTEXT_FILE" ] && exit 0
  TMP="${CONTEXT_FILE}.tmp.$$"
  jq --arg sid "$SESSION_ID" --arg tp "$TRANSCRIPT_PATH" \
     '. + {sessionId: $sid} + (if ($tp | length) > 0 then {transcriptPath: $tp} else {} end)' \
     "$CONTEXT_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$CONTEXT_FILE" 2>/dev/null || rm -f "$TMP"
  exit 0
  ```
- **File:** `platforms/claude-code/hooks/hooks.json` (MODIFY)
- **What:** Add a `SessionStart` array mirroring `SessionEnd`, pointing at `bash ${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh` with `"timeout": 5`.
- **Verify:** `bash -n platforms/claude-code/hooks/session-start.sh` + smoke test (corrected; JSON must be piped to the SCRIPT, not to `mkdir`):
  ```bash
  rm -rf /tmp/t && mkdir -p /tmp/t/.syntaur && echo '{}' > /tmp/t/.syntaur/context.json
  echo '{"session_id":"abc","transcript_path":"/tmp/x","cwd":"/tmp/t"}' | bash platforms/claude-code/hooks/session-start.sh
  cat /tmp/t/.syntaur/context.json   # should show merged sessionId + transcriptPath
  ```
- **Automated test:** see task 8a below — vitest spawns the hook with a fixture tmpdir to assert the merge and the "no create if absent" behavior.

### 14. Codex resolver helper

- **File:** `platforms/codex/scripts/resolve-session.sh` (CREATE)
- **What:** The script must respect a `CODEX_SESSIONS_DIR` env var (default `$HOME/.codex/sessions`) so the automated test can override the search root.
  ```bash
  #!/usr/bin/env bash
  set -o pipefail 2>/dev/null || true
  command -v jq >/dev/null 2>&1 || { exit 1; }
  TARGET_CWD="${1:-$PWD}"
  SESSIONS_ROOT="${CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
  shopt -s nullglob 2>/dev/null || true
  MATCHED_FILE=""
  MATCHED_ID=""
  # ls -t preserves mtime ordering. Walk newest-first until a cwd match is found.
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    FIRST=$(head -n 1 "$f" 2>/dev/null)
    [ -z "$FIRST" ] && continue
    SESSION_CWD=$(printf '%s' "$FIRST" | jq -r 'select(.type=="session_meta") | .payload.cwd // empty' 2>/dev/null)
    SESSION_ID=$(printf '%s' "$FIRST" | jq -r 'select(.type=="session_meta") | .payload.id // empty' 2>/dev/null)
    if [ "$SESSION_CWD" = "$TARGET_CWD" ] && [ -n "$SESSION_ID" ]; then
      MATCHED_FILE="$f"
      MATCHED_ID="$SESSION_ID"
      break
    fi
  done < <(ls -1t "$SESSIONS_ROOT"/*/*/*/rollout-*.jsonl 2>/dev/null)
  [ -z "$MATCHED_FILE" ] && exit 1
  printf 'session_id=%s\n' "$MATCHED_ID"
  printf 'transcript_path=%s\n' "$MATCHED_FILE"
  exit 0
  ```
- **Known limitation (documented):** if multiple concurrent Codex sessions share the same cwd, newest-by-mtime wins. Users override via explicit `--session-id` + `--transcript-path`.
- **Pattern:** Match `platforms/codex/scripts/session-cleanup.sh` style (shebang, `set -o pipefail`, `jq` gate).
- **Verify:** `bash -n platforms/codex/scripts/resolve-session.sh`.
- **Automated test:** see task 8b below.

### 15. Update Codex grab-assignment skill

- **File:** `platforms/codex/skills/grab-assignment/SKILL.md` (MODIFY)
- **What:**
  - **Step 8** JSON example: add `"transcriptPath": "<path-to-rollout-jsonl>"` after `sessionId`, and change the `sessionId` value in the example from `"<uuid>"` to `"<real-codex-session-id>"`.
  - **Step 9:** Replace the two sub-steps with:
    1. Run `bash ./scripts/resolve-session.sh "$(pwd)"` (relative to plugin root — mirror how `./scripts/session-cleanup.sh` is referenced in `platforms/codex/hooks.json:20`). Parse its `session_id=<id>` and `transcript_path=<path>` output lines. If the helper exits non-zero, abort with "no matching Codex rollout for this cwd — aborting registration".
    2. Merge `sessionId` + `transcriptPath` into `.syntaur/context.json` (preserve existing fields via `jq '. + {sessionId:$sid, transcriptPath:$tp}'`).
    3. Run `syntaur track-session --project <project-slug> --assignment <assignment-slug> --agent codex --session-id <id> --transcript-path <path> --path <cwd>`.
- **Verify:** Read-through. Run `npx vitest run src/__tests__/adapter-templates.test.ts` (per AGENTS.md rule for Codex adapter changes).

### 16. Update Codex operator agent prompt

- **File:** `platforms/codex/agents/syntaur-operator.md` (MODIFY)
- **What:**
  - **Line 96:** Change CLI example to `syntaur track-session --project <project-slug> --assignment <assignment-slug> --agent codex --session-id <real-id> --transcript-path <rollout-path> --path <cwd>`.
  - **Step 5 / "Claim an assignment" (around line 107):** Replace any UUID guidance with "resolve the real Codex session_id + rollout path via `./scripts/resolve-session.sh` (or equivalent lookup in `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` by `.payload.cwd` match). Do not invent IDs."
  - **Step 125:** Keep the existing "mark dashboard session completed if `sessionId` exists" behavior.
- **Verify:** `npx vitest run src/__tests__/adapter-templates.test.ts`

### 17. Bump plugin versions

- **File:** `platforms/claude-code/.claude-plugin/plugin.json` (MODIFY) — bump `version`.
- **File:** `platforms/codex/.codex-plugin/plugin.json` (MODIFY) — bump `version`.
- **What:** Use the next patch increment from the current value.

### 18. Dashboard client: mirror type + surface column

- **File:** `dashboard/src/types.ts` (MODIFY)
- **What:** Add `transcriptPath?: string | null` to client `AgentSession` (keep in sync with `src/dashboard/types.ts`).
- **File:** `dashboard/src/pages/AgentSessionsPage.tsx` (MODIFY)
- **What:**
  - Append `session.transcriptPath ?? ''` to the `haystack` array (around lines 93–104) so transcript path is searchable.
  - Add a compact visual for transcript path in the `SessionRow` render region. Prefer reusing the pattern used for the existing `path` column: monospace text, `title={transcriptPath}` tooltip, truncate on narrow widths. Include a small copy-to-clipboard button (use the same utility as whatever exists elsewhere in the dashboard — or inline `navigator.clipboard.writeText`).
  - If a shared `<SessionRow>` subcomponent exists, update its signature rather than duplicating logic.
- **Verify:** `npm run typecheck && npm run build:dashboard`

### 19. Strip uuidgen fallback from Claude SessionEnd cleanup

- **MUST run AFTER tasks 10, 11, 12, 13, 15, 16** — this is the final fallback removal, intentionally last.
- **File:** `platforms/claude-code/hooks/session-cleanup.sh` (MODIFY, lines 39–61)
- **What:**
  - If `SESSION_ID` is still empty after reading `context.json`, also try reading `.session_id` from the stdin `$INPUT` (SessionEnd payload includes it).
  - If still empty after both attempts, `exit 0` immediately (DO NOT `uuidgen`).
  - Remove the entire `uuidgen`/`cat /proc/sys/kernel/random/uuid`/`echo "ses-$(date +%s)"` block and the auto-register POST that depended on it. Rationale: registration now happens at SessionStart or via track-session/grab-assignment; SessionEnd's sole remaining job is the status PATCH.
- **Verify:** `bash -n platforms/claude-code/hooks/session-cleanup.sh`

### 20. Docs: update file-formats + session-rule

- **File:** `docs/protocol/file-formats.md` (MODIFY)
- **What:** Update the `sessions` table schema section (currently mentions the v2 columns) to include `transcript_path TEXT NULL`. Add a brief section "Session ID rule" stating: all session_ids must be real agent-generated IDs (never synthesized). Claude sources from `~/.claude/sessions/<pid>.json` or the SessionStart hook payload; Codex sources from `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (first line `.payload.id`).
- **Verify:** Read-through.

## Verification (run in order at the end)

1. `npm run typecheck`
2. `npm run build` (required before the CLI subprocess test at task 8)
3. `npx vitest run src/__tests__/agent-sessions.test.ts`
4. `npx vitest run src/__tests__/commands.test.ts`
5. `npx vitest run src/__tests__/hook-session-start.test.ts`
6. `npx vitest run src/__tests__/codex-resolve-session.test.ts`
7. `npx vitest run src/__tests__/dashboard-api.test.ts`
8. `npx vitest run src/__tests__/adapter-templates.test.ts`
9. `npm test` (full suite)
10. `npm run build:dashboard`
11. `bash -n platforms/claude-code/hooks/session-start.sh platforms/claude-code/hooks/session-cleanup.sh platforms/codex/scripts/resolve-session.sh`
12. Manual smoke: `rm -f ~/.syntaur/syntaur.db && node dist/index.js track-session --agent claude` → must exit non-zero with required-flag error; repeat with `--session-id abc123 --transcript-path /tmp/x.jsonl --path /tmp` → must succeed; `sqlite3 ~/.syntaur/syntaur.db "SELECT session_id, transcript_path FROM sessions"` → one row with both values populated.

## Files intentionally not changed

- `src/templates/codex-agents.ts` — Grep for `session-id`, `sessionId`, `session_id` in this file comes back empty. Line 31's `track-session` mention refers to the Codex plugin's tmux tracking skill (`platforms/codex/skills/track-session/SKILL.md`), NOT the dashboard CLI `syntaur track-session`. So per the AGENTS.md alignment rule, no update is warranted for this change.
- `platforms/codex/skills/track-session/SKILL.md`, `platforms/codex/commands/track-session.md` — tmux tracking; unrelated to agent-session registration.

## Known limitations (deferred)

- Existing synthetic UUID rows remain in users' dbs. Purge is a future `syntaur sessions prune-synthetic` command.
- Cursor / OpenCode adapters do not yet have a real-session-id source. No change in this pass.
- Codex concurrent sessions in the same cwd: resolver picks newest by mtime. Users can override via explicit `--session-id` + `--transcript-path`.
