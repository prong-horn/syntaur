# Token Usage Tracking — Lite Plan (v3, post second codex review)

**Date:** 2026-05-21
**Complexity:** medium
**Tech stack:** TypeScript ESM, Node ≥20, better-sqlite3, commander v13, express v5, ws, vitest v3, tsup. Dashboard package (separate `dashboard/package.json`) is React 18.3 + Vite v6 + Tailwind + react-router-dom v7.
**Branch / worktree:** `research/token-usage-tracking` at `/Users/brennen/syntaur/.worktrees/research/token-usage-tracking`.
**Assignment:** `~/.syntaur/projects/syntaur-meta/assignments/token-usage-tracking-research-coding-agent-cli-ecosystem` (this file is the project plans-convention plan, distinct from the assignment-level `plan.md` under the assignment dir).

## Objective

Implement per-assignment / per-project token-usage tracking. A new `src/db/usage-db.ts` SQLite module mirrors `leases-db.ts` / `proof-db.ts` (shared `~/.syntaur/syntaur.db`, WAL, exclusive migrations, own `usage_schema_version` meta key). A graceful `ccusage` shell-out collector ingests one row per `(session_id, model)` per collector run. A Claude+Codex JSONL `cwd` extractor (reusing `derivePathFromTranscript` for Claude Code, top-level `timestamp` + `payload.{id,cwd}` for Codex) tags events. A join layer maps `(session_id | cwd, eventTs)` to `(project_slug, assignment_slug)` against the existing `sessions` table — using `sessions.path` for the cwd fallback and `julianday()` to normalize the format mismatch between `sessions.started` (ISO) and `sessions.ended` (SQLite `YYYY-MM-DD HH:MM:SS`). A daily rollup is **computed-from-scratch on each run** (no freeze in v1 — see Risks for cross-day-double-count rationale). A `syntaur usage` CLI and a `/usage` dashboard route surface results.

**Two redesign decisions vs plan v2 (driven by second codex review):**

1. **No `usage_daily.frozen` in v1.** The original toktrack-pattern freeze caused a cross-UTC-day double-count: a session with 100 tokens before midnight + 200 cumulative after midnight would freeze 100 on day 1 and roll up the full 200 onto day 2 = 300 total. The freeze-resilience pattern is deferred to v2; v1 always recomputes `usage_daily` from current `usage_events` state. The `frozen` column stays in the schema (default 0) so v2 can populate it without a migration; v1 rollup runner ignores it on write but respects it on read for forward-compatibility.
2. **Collector returns parsed rows in memory only.** Persistence (event upsert + `usage_last_collector_run` meta update + rollup) happens entirely inside `src/commands/usage.ts` after attribution enrichment, in a single transaction. This eliminates the plan-v2 race where the collector could persist rows + advance `last_run` before the CLI could attribute them — leaving orphan unattributed rows that re-runs would never revisit.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/db/usage-db.ts` | CREATE | Singleton DB module. `usage_events` + `usage_daily` schemas. Idempotent on `(session_id, model)`. Owns `usage_schema_version='1'` and a `usage_last_collector_run` meta key. Local `nowIso()` helper (copies `leases-db.ts`'s implementation; see Medium fix in plan v1 review). |
| `src/usage/ccusage-collector.ts` | CREATE | Spawns `ccusage session --json [--since <YYYYMMDD>] [--breakdown]`; graceful `ENOENT` degrade with single one-line install hint; runtime-parses `unknown` JSON with permissive field extraction. **Does NOT write to the DB** — returns parsed rows + the high-water-mark timestamp to the caller. |
| `src/usage/cwd-extractor.ts` | CREATE | Reads Claude Code + Codex JSONL session files via `expandHome()` from `src/utils/paths.ts`. For Codex: line-1 `type==='session_meta'` with top-level `timestamp` and `payload.{id,cwd}`. For Claude Code: reuse `derivePathFromTranscript` from `src/utils/transcript.ts` for cwd; `sessionId` = basename without `.jsonl`; `startTs`/`endTs` via bounded forward + reverse scan (specified below). |
| `src/usage/session-join.ts` | CREATE | Resolves `(sessionId | cwd, eventTs)` → `(project_slug, assignment_slug)` against `sessions`. PK match first; fallback uses `sessions.path = ? AND julianday(started) <= julianday(?) AND (ended IS NULL OR julianday(ended) >= julianday(?))`. Accepts injected DB handles for tests. |
| `src/usage/rollup-runner.ts` | CREATE | Recomputes `usage_daily` from scratch on each run (v1 — no freeze). `DELETE FROM usage_daily WHERE frozen = 0` then INSERT current aggregates. Frozen rows are preserved untouched for forward-compat with v2. |
| `src/commands/usage.ts` | CREATE | CLI `syntaur usage [--since|--until|--project|--assignment|--json]` (no `--tool`; no `--all-events`; rationale in Risks). Action sequence in Task 6. Exports a `Command` named `usageCommand`. |
| `src/dashboard/api-usage.ts` | CREATE | Express Router (`createUsageRouter()` — no `broadcast` param in v1). Endpoints: `GET /` (summary by project; accepts `?since=&until=&project=&assignment=&groupBy=`), `GET /projects/:projectSlug` (per-assignment rollup; same query params), `GET /projects/:projectSlug/assignments/:assignmentSlug` (event detail), `GET /standalone/:assignmentId` (UUID-keyed standalone variant). Each handler calls `initUsageDb()` first. Localhost-only — no auth, matching existing routers. |
| `dashboard/src/pages/UsagePage.tsx` | CREATE | React page with date-range inputs (`since`, `until`) + project filter, rendering rollup table. Mirrors `InventoriesPage.tsx` / `AgentSessionsPage.tsx`. |
| `dashboard/src/App.tsx` | MODIFY | Register `<Route path="/usage" element={<UsagePage />} />` at top level (no workspace scoping — matches `/inventories` and `/agent-sessions`). |
| `dashboard/src/lib/routes.ts` | MODIFY | Add `/usage` to the top-level route list + breadcrumbs (matches the `inventories` entry at line ~19 + breadcrumb block ~line 173). |
| `dashboard/src/components/AppShell.tsx` | MODIFY | Add a nav entry for "Usage" alongside the existing Inventories / Sessions entries. |
| `dashboard/src/hotkeys/paletteIndex.ts` | MODIFY (optional v1) | Add Usage to the command palette index if other top-level pages are registered there. Skip if unclear; flag for v2. |
| `src/dashboard/server.ts` | MODIFY | Add `initUsageDb()` next to existing `initSessionDb()` / `initLeasesDb()` (~lines 145-151). Add `app.use('/api/usage', createUsageRouter())` next to existing routes (~line 714). Import + call `closeUsageDb()` in `stop()` next to `closeSessionDb()` / `closeLeasesDb()` (~lines 841-842, verified). |
| `src/index.ts` | MODIFY | Add `import { usageCommand } from './commands/usage.js'` and `program.addCommand(usageCommand);` in the `addCommand` block (~lines 830-841, verified — uses `addCommand`, not inline `program.command(...)`). |
| `src/__tests__/usage-db.test.ts` | CREATE | Vitest — schema init idempotency, UPSERT semantics, immutability of frozen days. Explicit `closeUsageDb()` in `afterEach`. |
| `src/__tests__/ccusage-collector.test.ts` | CREATE | Vitest — fixture-backed happy path; `ENOENT` degrade via `PATH=''` env override. |
| `src/__tests__/cwd-extractor.test.ts` | CREATE | Vitest — Claude + Codex fixtures (top-level `timestamp`, `payload.{id,cwd}`). |
| `src/__tests__/session-join.test.ts` | CREATE | Vitest — PK match, `sessions.path` + julianday() time-range fallback, ISO-vs-SQLite-format mixed sessions, unattributed null result. |
| `src/__tests__/rollup-runner.test.ts` | CREATE | Vitest — recompute correctness, `frozen=1` rows preserved across recomputes (forward-compat), idempotent re-run, cross-UTC-day regression. |
| `src/__tests__/dashboard-api-usage.test.ts` | CREATE | Vitest — mount Express app, use global `fetch` against an ephemeral port (matches `dashboard-api.test.ts` pattern; no `supertest` dependency). |
| `src/__tests__/fixtures/ccusage-session.json` | CREATE | **Real** `ccusage session --json --breakdown` capture. JSON cannot carry comments — pair the file with a sibling `src/__tests__/fixtures/ccusage-session.meta.json` that records `{ccusageVersion, capturedAt, command, captureMachine}` (or embed those fields under a top-level `_meta` key inside the fixture if the parser tolerates additive fields). No synthesized stub permitted — if ccusage cannot be installed, implementation halts and the user is asked before the parser is written. |
| `src/__tests__/fixtures/cwd/claude/<sid>.jsonl` | CREATE | Minimal Claude Code transcript: line 1 `permission-mode`, line 2 `file-history-snapshot`, line 3 `user` event carrying `cwd`, `sessionId`, and `timestamp`. |
| `src/__tests__/fixtures/cwd/codex/rollout-<id>.jsonl` | CREATE | Minimal Codex rollout: line 1 `{type:"session_meta", timestamp:ISO, payload:{id, cwd}}`; line 2 stub event. |

## Tasks

### 1. usage-db (foundation)

- **File:** `src/db/usage-db.ts` (CREATE)
- **Schemas:**
  - `usage_events` (one row per session × model snapshot; UPSERT on collect):
    ```sql
    CREATE TABLE IF NOT EXISTS usage_events (
      session_id              TEXT NOT NULL,
      model                   TEXT NOT NULL,
      tool                    TEXT NOT NULL,            -- 'claude-code' | 'codex' | 'gemini' | ...
      event_ts                TEXT NOT NULL,             -- canonical ISO from nowIso() or session lastActivity
      input_tokens            INTEGER NOT NULL DEFAULT 0,
      output_tokens           INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
      total_tokens            INTEGER NOT NULL DEFAULT 0,
      total_cost              REAL    NOT NULL DEFAULT 0,
      cwd                     TEXT,
      project_slug            TEXT NOT NULL DEFAULT '',
      assignment_slug         TEXT NOT NULL DEFAULT '',
      raw_json                TEXT,
      updated_at              TEXT NOT NULL,
      PRIMARY KEY (session_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_ts          ON usage_events (event_ts);
    CREATE INDEX IF NOT EXISTS idx_usage_events_attribution ON usage_events (project_slug, assignment_slug);
    CREATE INDEX IF NOT EXISTS idx_usage_events_cwd         ON usage_events (cwd, event_ts);
    ```
    Idempotency contract: `INSERT INTO usage_events (...) VALUES (...) ON CONFLICT(session_id, model) DO UPDATE SET <all columns except PK> = excluded.*`. Re-running the collector against unchanged ccusage output produces the same DB state. NOTE: this resolves codex-review CRITICAL on `event_seq` + `NOT NULL`. The `(session_id, event_seq)` wording in the assignment criteria is updated to `(session_id, model)` — recorded in the assignment update.
  - `usage_daily` (recomputed-on-each-run in v1; `frozen` column preserved for v2):
    ```sql
    CREATE TABLE IF NOT EXISTS usage_daily (
      day                     TEXT NOT NULL,             -- 'YYYY-MM-DD' UTC
      tool                    TEXT NOT NULL,
      model                   TEXT NOT NULL,
      project_slug            TEXT NOT NULL DEFAULT '',
      assignment_slug         TEXT NOT NULL DEFAULT '',
      input_tokens            INTEGER NOT NULL DEFAULT 0,
      output_tokens           INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
      total_tokens            INTEGER NOT NULL DEFAULT 0,
      total_cost              REAL    NOT NULL DEFAULT 0,
      frozen                  INTEGER NOT NULL DEFAULT 0,  -- always 0 in v1; populated in v2 by closed-session promotion
      computed_at             TEXT NOT NULL,
      PRIMARY KEY (day, tool, model, project_slug, assignment_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily (day);
    ```
    All PK columns NOT NULL (codex-review CRITICAL); model included per decision-record (codex-review CRITICAL); unattributed events get `project_slug = '' AND assignment_slug = ''`. The `frozen` column is kept so v2 can populate it without a migration, but the v1 runner never writes a non-zero value; v1 rollup deletes only `WHERE frozen = 0` so any future v2 frozen rows survive.
  - `meta` table: shared with `proof-db` / `leases-db`. Owned keys: `usage_schema_version = '1'`, `usage_last_collector_run` (ISO timestamp; absent until first successful run).
- **Pattern:** Mirror `src/db/leases-db.ts` (lines 36-264). `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`. Migrations inside `database.transaction(() => {...}).exclusive()`. No FK to `sessions(session_id)` because ccusage will surface sessions Syntaur never tracked; the join is logical not referential (codex-review CRITICAL resolved by explicit decision).
- **Helpers:** local `nowIso()` (lexicographic-safe ISO 8601; copies the implementation from `leases-db.ts`) — avoid cross-DB-module import per plan-v1 codex review MEDIUM. Or: extract `nowIso` to a tiny new file `src/utils/iso-timestamp.ts` and re-export from leases-db. Decision: define locally in usage-db for v1; refactor to shared util in a follow-up if a third caller appears.
- **Public API:**
  - `initUsageDb(dbPath?: string): Database.Database`
  - `getUsageDb(): Database.Database`
  - `closeUsageDb(): void`
  - `resetUsageDb(): void`
  - `upsertEvent(input: UsageEventInput): void` (UPSERT semantics)
  - `listEvents(filter: { since?: string; until?: string; projectSlug?: string; assignmentSlug?: string; tool?: string }): UsageEventRow[]`
  - `insertDailyBatch(rows: UsageDailyInput[]): void` (single-transaction `DELETE WHERE frozen = 0` + bulk INSERT; the v1 atomic recompute primitive)
  - `listDaily(filter): UsageDailyRow[]`
  - `getMeta(key: string): string | null`, `setMeta(key: string, value: string): void`
- **Tests (`src/__tests__/usage-db.test.ts`):** schema init idempotency; `usage_events` UPSERT updates fields in place; `insertDailyBatch` deletes only `frozen=0` rows and atomically replaces; pre-existing `frozen=1` rows survive across multiple `insertDailyBatch` calls (forward-compat check); `getMeta`/`setMeta` round-trip; concurrent read while writing under WAL. Use `mkdtemp` + `resetUsageDb()` + `closeUsageDb()` per `proof-db.test.ts` shape (NOT `closeAll` — that helper doesn't exist; codex-review MEDIUM).

### 2. cwd extractor

- **File:** `src/usage/cwd-extractor.ts` (CREATE)
- **Exports:**
  - `extractCodexSessionMeta(jsonlPath: string): Promise<CodexSessionMeta | null>`
    Read line 1, JSON.parse, require `type === 'session_meta'`, pull top-level `timestamp` (NOT `payload.timestamp` — codex-review CRITICAL: verified against `src/__tests__/codex-resolve-session.test.ts:30-34`) and `payload.id`, `payload.cwd`. Returns `{ sessionId, cwd, startTs, endTs }` where `endTs` is read from the LAST line of the file via the bounded tail-scan below.
  - `extractClaudeSessionMeta(jsonlPath: string): Promise<ClaudeSessionMeta | null>`
    `sessionId` = `basename(jsonlPath).replace(/\.jsonl$/, '')`. `cwd` via `derivePathFromTranscript` (reuse from `src/utils/transcript.ts`). `startTs` from first JSON line carrying a `timestamp` field (forward scan, max 50 lines — matches `derivePathFromTranscript`'s existing cap). `endTs` via tail-scan.
  - `walkClaudeProjects(root?: string): AsyncIterable<string>` — `expandHome(root ?? '~/.claude/projects')` per codex-review HIGH. One `cwd` is cached per directory after the first session in it produces a hit.
  - `walkCodexSessions(root?: string): AsyncIterable<string>` — root resolves as `expandHome(process.env.CODEX_SESSIONS_DIR ?? (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : '~/.codex/sessions'))`. Supports nested `YYYY/MM/DD/rollout-*.jsonl` AND flat `*.jsonl` (codex-review HIGH).
- **Tail-scan algorithm (specified per codex-review MEDIUM):**
  - For `endTs`: open file, `fstat()` to get size; read the last 8 KiB (or full file if smaller) via `fs.read` into a buffer; split on `\n`, walk lines from end to start, JSON.parse each non-empty line, return first parsed object's `timestamp` field. If none found in 8 KiB, fall back to `startTs`. Hard cap at 64 KiB worst-case re-scan. Defer to streaming line-by-line only if profiling shows the tail-scan is slow on very long transcripts.
- **Tests (`src/__tests__/cwd-extractor.test.ts`):** Codex fixture (top-level timestamp); Claude fixture (cwd via shared utility); both walkers via `mkdtemp` + writeFile fixtures.

### 3. ccusage collector (pure parser; no DB writes)

- **File:** `src/usage/ccusage-collector.ts` (CREATE)
- **Function signature:** `runCcusage(opts: { sinceDate?: string }): Promise<{ rows: ParsedCcusageRow[]; highWaterMark: string | null; ccusageVersion: string } | null>`
  - `sinceDate` is a `YYYYMMDD` string (ccusage's native session-filter format — codex-review HIGH; verify ISO support during fixture capture and convert if needed). Caller passes the date portion of `usage_last_collector_run` if present, else 30 days ago.
- **Behavior:**
  - Spawn `ccusage session --json [--since <YYYYMMDD>] [--breakdown]` via `node:child_process.spawn` (no shell). Always pass `--breakdown` so the parser can rely on per-model rows; verify during fixture capture whether `--breakdown` is the right flag name (codex-review HIGH — alternative is to derive per-model from a `modelBreakdowns[]` array embedded in each session row). If the real fixture already exposes per-model totals without `--breakdown`, drop the flag and note it in code comments.
  - Also spawn `ccusage --version` once (or read it from `--version` in the first call) and surface as `ccusageVersion`; the CLI stamps this into a log line for postmortems.
  - On spawn `ENOENT`, log once: `"ccusage not on PATH — install with 'npm i -g ccusage' or 'bunx ccusage' to enable token usage tracking"` and return `null`. Do NOT throw.
  - On non-zero exit: log `stderr` (truncated to 1024 chars), return `null`.
  - On success: `JSON.parse(stdout)` cast to `unknown`. Walk via a tolerant runtime parser (`src/usage/ccusage-parse.ts`) that extracts `{sessionId, model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens, totalCost, lastActivity}` from each session×model breakdown. **Field names MUST come from a real `ccusage session --json --breakdown` capture committed as `src/__tests__/fixtures/ccusage-session.json` BEFORE the parser is written.** No synthesized-from-docs fallback (codex-review MEDIUM tightened to MUST). If `ccusage` cannot be installed on the dev machine when implementation starts, halt and surface the blocker to the user before writing the parser.
  - Yield one `ParsedCcusageRow { sessionId, model, tool, eventTs, input/output/cache_creation/cache_read/total_tokens, total_cost, raw_json }` per session×model row. `tool` is derived from a ccusage row field (confirm during fixture capture — likely `agent`, `source`, or inferred from session path prefix; document the exact mapping in the parser).
  - `highWaterMark` = max `lastActivity` (or equivalent) across all returned rows, as ISO. **If the rows array is empty, `highWaterMark` is `null`** — the CLI MUST NOT advance `usage_last_collector_run` in that case (a stuck `--since` is better than skipping a window that might have produced data on the next run).
- **Does NOT touch the DB.** All persistence happens in the CLI task (codex-review NEW CRITICAL #2).
- **Pattern:** `child_process.spawn` shape from `src/utils/git-worktree.ts`. No new dependencies.
- **Tests (`src/__tests__/ccusage-collector.test.ts`):**
  - Happy path: stub a `ccusage` script in a tmp dir (shell script that prints the fixture JSON), prepend it to `PATH`, assert `runCcusage()` returns the expected rows.
  - ENOENT: `env: { PATH: '' }` override; assert `null` returned (no DB assertions — collector doesn't touch DB).
  - Non-zero exit: stub script `exit 1`; assert `null` returned.
  - Parser fixture round-trip: feed the JSON fixture directly into the parser module and assert the row shape — this is the test that gates field-name correctness.
- **Open before implementing:** install `ccusage` (`npm i -g ccusage`) and capture a real `ccusage session --json --breakdown` to commit as the fixture, paired with a sibling `*.meta.json` recording version/date/command. **No synthesized stub is acceptable** (codex-review MEDIUM). If the install fails, halt and ask the user; do not proceed to write the parser blind.

### 4. session join

- **File:** `src/usage/session-join.ts` (CREATE)
- **Function:** `resolveAttribution(input: { sessionId: string; cwd: string | null; eventTs: string }, db?: Database.Database): { projectSlug: string | null; assignmentSlug: string | null }`.
  - Caller must have called `initSessionDb()` (the CLI does this — codex-review CRITICAL).
  - **Step 1 (PK):** `SELECT project_slug, assignment_slug FROM sessions WHERE session_id = ?`. Returns the row if matched (even if both columns are NULL — that's an explicit unattributed session).
  - **Step 2 (fuzzy fallback, only if `cwd != null` and step 1 returned no row):**
    ```sql
    SELECT project_slug, assignment_slug
    FROM sessions
    WHERE path = ?
      AND julianday(started) <= julianday(?)
      AND (ended IS NULL OR julianday(ended) >= julianday(?))
    ORDER BY started DESC
    LIMIT 1
    ```
    `julianday()` normalizes the format mismatch between `sessions.started` (ISO from `new Date().toISOString()`) and `sessions.ended` (SQLite `YYYY-MM-DD HH:MM:SS` from `datetime('now')` per `src/dashboard/agent-sessions.ts:113`). Both arguments are the event ISO timestamp (julianday() accepts both).
  - Returns `{projectSlug: null, assignmentSlug: null}` when neither matches.
- **Schema impact:** consider adding a `(path, started)` index in a follow-up; not required for v1 (codex-review MEDIUM accepted as cost of small datasets).
- **Tests (`src/__tests__/session-join.test.ts`):**
  - Direct PK match returns row's slugs.
  - Fuzzy match against `sessions.path = event.cwd` within `[started, ended]`.
  - Fuzzy match with `ended = NULL` (still-active session) accepts events with `event_ts >= started`.
  - Mixed-format `started` (ISO) + `ended` (SQLite datetime) — both compare correctly under `julianday()`.
  - No-match returns `{null, null}`.

### 5. rollup runner (v1: recompute-from-scratch; no freeze)

- **File:** `src/usage/rollup-runner.ts` (CREATE)
- **Function:** `runRollup(): { daysComputed: number; rowsWritten: number }`.
  - Inside one `db.transaction(...).immediate()`:
    1. `DELETE FROM usage_daily WHERE frozen = 0` — wipe all non-frozen rows (in v1 every row is frozen=0; in v2 frozen rows survive).
    2. `INSERT INTO usage_daily (day, tool, model, project_slug, assignment_slug, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens, total_cost, frozen, computed_at) SELECT date(event_ts) AS day, tool, model, project_slug, assignment_slug, SUM(...), 0 AS frozen, ? AS computed_at FROM usage_events GROUP BY 1, 2, 3, 4, 5` — pure SQL aggregation; one INSERT per group.
  - **Why no freeze in v1:** the mutable `(session_id, model)` UPSERT model means a long-running session's totals shift over time. Freezing yesterday's snapshot of an in-flight session leads to the cross-UTC-day double-count caught by codex review #2. v1 always reflects current `usage_events` state; v2 will add a `usage_session_closed` table for sessions ccusage no longer reports, then promote those to `frozen = 1` daily rows. This is recorded as Decision 4 in `decision-record.md`.
  - **Trade-off accepted:** if ccusage rotates / deletes its session logs (Claude Code rotates after ~30 days, Codex similar), v1 loses pre-rotation totals from `usage_events` and therefore from `usage_daily` rollups. Mitigated by running the collector frequently (e.g., on the existing `SessionEnd` hook in Phase 3) so closed sessions are captured before their logs rotate. v2's `usage_session_closed` will harden this.
- **Tests (`src/__tests__/rollup-runner.test.ts`):**
  - Recompute produces correct sums per `(day, tool, model, project_slug, assignment_slug)` from seeded `usage_events`.
  - Pre-existing `frozen=1` rows in `usage_daily` survive a `runRollup()` call (forward-compat).
  - Running `runRollup()` twice on the same `usage_events` snapshot produces identical `usage_daily` state (idempotent).
  - Cross-UTC-day scenario: a single `(session_id, model)` event whose `event_ts` falls on day D and is later UPSERT'd with growth and `event_ts` on day D+1 produces NO double-count — only the latest `event_ts` row contributes, and only to its current day. (This is the regression test for the codex-review CRITICAL.)

### 6. CLI `syntaur usage` (the only place persistence happens)

- **File:** `src/commands/usage.ts` (CREATE), `src/index.ts` (MODIFY)
- **Shape:** export a Commander `Command` named `usageCommand` and register via `program.addCommand(usageCommand)` in the existing block at `src/index.ts:830-841` (verified — pattern matches `leaseCommand`, `lsCommand`).
- **Options:** `--since <iso>`, `--until <iso>`, `--project <slug>`, `--assignment <slug>`, `--json`. No `--tool` (codex-review HIGH). No `--all-events` (codex-review LOW — listEvents stays internal to dashboard API for v1).
- **Action sequence:**
  1. `initSessionDb()`, `initUsageDb()`.
  2. `lastRunIso = getMeta('usage_last_collector_run')`. Derive `sinceDate = lastRunIso ? lastRunIso.slice(0,10).replace(/-/g, '') : <30 days ago YYYYMMDD>` so first run is bounded by the same 30-day window as the session-file walk below (codex-review HIGH on first-run mismatch).
  3. `result = await runCcusage({ sinceDate })`. If `null`, skip ingest and go straight to step 8 (still emit rollups + render from whatever's already in the DB).
  4. Discover session metadata: walk `~/.claude/projects/**/*.jsonl` and `$CODEX_SESSIONS_DIR / $CODEX_HOME/sessions / ~/.codex/sessions /**/rollout-*.jsonl`. Filter by mtime ≥ `sinceDate` (same window as the ccusage call). Build a `Map<sessionId, { cwd, startTs, endTs }>`.
  5. For each `ParsedCcusageRow` from step 3, look up cwd from the map (`null` if not found); call `resolveAttribution({ sessionId, cwd, eventTs })`; merge `(projectSlug, assignmentSlug, cwd)` into the row.
  6. Inside one `db.transaction(...).immediate()`:
     a. `upsertEvent(row)` for every enriched row (one statement loop).
     b. If `result.highWaterMark != null`, `setMeta('usage_last_collector_run', result.highWaterMark)`. If null (empty-rows case), skip — `last_run` does not advance.
  7. (Note: steps 6a and 6b are atomic — either all rows persist AND last_run advances, or neither happens. This fixes the plan-v2 race where the collector could write rows before attribution and orphan them with last_run advanced.)
  8. `runRollup()` (separate transaction; safe to run independently).
  9. Query `listDaily(filter)` and render. Default human output: small table grouped by `(project_slug, assignment_slug)` with summed `total_tokens` and `total_cost`. `--json` emits raw arrays.
- **First-run policy:** when `usage_last_collector_run` is absent, bound the ingest to **last 30 days** for both ccusage (`--since` in YYYYMMDD) and the session-file walk. Older history is not backfilled in v1 — surfaced as a one-line note in the CLI output. This eliminates the codex-review NEW HIGH on first-run history vs 30-day walk mismatch.
- **Tests (`src/__tests__/usage-cli.test.ts` — new file):** vitest snapshot test of human + JSON renderers against a seeded DB; integration test that stubs `ccusage` on `PATH`, walks fixture cwd files, runs the full sequence, and asserts both `usage_events` and `usage_daily` state. Atomicity test: inject a thrown error between upsertEvent and setMeta to assert that `last_run` does NOT advance.

### 7. Dashboard API + view

- **Files:** `src/dashboard/api-usage.ts` (CREATE), `dashboard/src/pages/UsagePage.tsx` (CREATE), `dashboard/src/App.tsx` (MODIFY), `dashboard/src/lib/routes.ts` (MODIFY), `dashboard/src/components/AppShell.tsx` (MODIFY), `src/dashboard/server.ts` (MODIFY).
- **API:**
  - `createUsageRouter(): express.Router` — no `broadcast` param (codex-review LOW). Endpoints all accept `?since=&until=&project=&assignment=&groupBy=`:
    - `GET /` → top-level summary grouped by `project_slug` by default (override with `groupBy`).
    - `GET /projects/:projectSlug` → per-assignment rollup for that project.
    - `GET /projects/:projectSlug/assignments/:assignmentSlug` → event detail for one project-scoped assignment (codex-review HIGH: slugs aren't globally unique).
    - `GET /standalone/:assignmentId` → standalone-assignment variant keyed by UUID id.
  - All handlers call `initUsageDb()` first (matches `api-leases.ts` pattern).
  - Localhost-only — no auth (matches existing routers).
- **UI:**
  - `UsagePage.tsx`: date-range inputs (`since`, `until`, defaults to last 30 days), optional `project` dropdown reusing `useProjects` hook from `dashboard/src/hooks/useProjects.ts`, table of `{ project_slug, assignment_slug, total_tokens, total_cost, last_event_ts }`. State + fetch shape from `InventoriesPage.tsx`.
  - Register route in `App.tsx` (top-level, not workspace-scoped). **Decision recorded:** usage is intentionally global in v1 because the `sessions` table is single-DB single-machine and there is no workspace partitioning at the data layer; `/inventories` and `/agent-sessions` made the same call. If multi-workspace dashboards are added later, `/w/:workspace/usage` can mount the same UsagePage with a workspace filter — no schema change required. (codex-review MEDIUM resolved.)
  - Add `/usage` to breadcrumb logic in `lib/routes.ts` and nav entry in `AppShell.tsx` (codex-review HIGH).
  - Palette index registration deferred to v2 (mark as TODO).
- **Server wire-up:**
  - `initUsageDb()` near existing `initSessionDb()` / `initLeasesDb()` (`src/dashboard/server.ts:145-151`).
  - `app.use('/api/usage', createUsageRouter())` near existing routes (~line 714).
  - `closeUsageDb()` in `stop()` alongside `closeSessionDb()` / `closeLeasesDb()` (`server.ts:841-842`, verified).
- **Tests (`src/__tests__/dashboard-api-usage.test.ts`):** mount Express app inline (matches `dashboard-api.test.ts`), assert each endpoint's response shape against seeded `usage_daily` rows. Use global `fetch` (no `supertest` dep — codex-review HIGH).

### 8. Verification

- `npm run typecheck` — checks `src/`. NOTE: dashboard frontend has its own tsconfig; run `npm run build --prefix dashboard` separately (codex-review HIGH).
- `npm test` — vitest runs all `src/__tests__/*.test.ts`.
- `npm run build` then `node dist/index.js usage --json` — smoke CLI against the user's actual DB.
- `syntaur dashboard --dev` OR `npm run build:dashboard && syntaur dashboard` — open the dashboard at the printed URL, navigate to `/usage`. (`npm run dev` at the root is `tsup --watch` — NOT the dashboard; codex-review CRITICAL.)

## Acceptance-Criteria Mapping (assignment.md Phase 2)

| # | Criterion | Task |
|---|---|---|
| 1 | `src/db/usage-db.ts` with `usage_events` + `usage_daily`, WAL + busy_timeout + foreign_keys, own meta key, mirrors leases-db/proof-db | Task 1 |
| 2 | Idempotent `(session_id, model)` writes — wording updated from `(session_id, event_seq)` per codex review | Task 1 (UPSERT) |
| 3 | ccusage shell-out collector w/ graceful ENOENT degrade | Task 3 |
| 4 | cwd-extraction reader for Claude + Codex JSONL | Task 2 |
| 5 | Join `(cwd, time-range) → (project_slug, assignment_slug)` using `sessions.path` and `julianday()` | Task 4 |
| 6 | Daily rollup (v1: recompute-from-scratch on every run; `frozen` column reserved for v2 closed-session promotion) | Tasks 1 + 5 |
| 7 | CLI `syntaur usage [--since|--until|--project|--assignment|--json]` (no `--tool`) | Task 6 |
| 8 | Dashboard API endpoint + view | Task 7 |
| 9 | Vitest unit tests for each module | All tasks |
| 10 | `npm run typecheck` + `npm test` + `npm run build --prefix dashboard` clean | Task 8 |
| 11 | Codex code review clean | post-implementation |

Out of scope (Phase-3 optional in assignment): `SessionEnd` hook, statusline integration.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cross-UTC-day double-count (codex-review NEW CRITICAL #1) | v1 drops `usage_daily.frozen` runtime semantics: rollup is always recomputed from scratch from current `usage_events`. Frozen column preserved for v2 forward-compat (v2 adds `usage_session_closed` table for ccusage-rotated sessions). Tested by an explicit cross-day regression test. |
| Collector / CLI persistence race (codex-review NEW CRITICAL #2) | Collector is a pure parser; persistence (event upsert + last_run advance) happens only inside the CLI's single transaction. Atomicity tested explicitly. |
| ccusage `--since` format may be `YYYYMMDD` not ISO (codex-review NEW HIGH) | CLI converts the ISO `usage_last_collector_run` to `YYYYMMDD` before passing to ccusage. Fixture-capture step verifies; collector module documents what it observed in code comments. |
| ccusage per-model rows may need `--breakdown` (codex-review NEW HIGH) | Collector passes `--breakdown`; if the real fixture proves it redundant (per-model already nested in `modelBreakdowns[]`), drop the flag and note in comments. |
| First-run history vs 30-day cwd-walk mismatch (codex-review NEW HIGH) | First run defaults to a 30-day window for BOTH ccusage `--since` and the session-file walk. Older history is not backfilled in v1; documented in CLI output. |
| ccusage JSON field names differ between docs and actual binary | Install ccusage and capture a real fixture BEFORE writing the parser. Pin the verified `ccusage --version` in a code comment. No synthesized-from-docs fallback — implementation halts if ccusage can't be installed. |
| Idempotency redefinition `(session_id, event_seq) → (session_id, model)` | Recorded as `decision-record.md` Decision 3. Assignment's Phase-2 criterion #2 updated. |
| Today-recompute stale groups (codex-review NEW MEDIUM) | Rollup runner does `DELETE FROM usage_daily WHERE frozen = 0` before INSERT — atomic full rebuild of the unfrozen partition; no stale `(day, tool, model, project, assignment)` tuples survive. |
| `ccusage` ENOENT | Collector returns `null`; CLI/API still serve existing DB contents. Single info log per process. |
| Claude `cwd-slug` legitimate-`-` ambiguity | Treat directory name as opaque; read `cwd` from inside via `derivePathFromTranscript`. Cache one cwd per dir. |
| Sessions time-format mismatch (`started` ISO vs `ended` SQLite datetime) | All time comparisons go through `julianday()`. Tested explicitly. |
| Codex JSONL shape variance | Only line-1 `session_meta` envelope's top-level `timestamp` + `payload.{id,cwd}` required. Missing → skip file with single log. |
| Dashboard route surface (codex-review HIGH on slug ambiguity) | Project-scoped + standalone-UUID variants both exposed. Top-level `/usage` route, not workspace-scoped (matches `/inventories`); rationale documented in Task 7. |
| Stale upstream text in assignment.md (codex-review NEW LOW) | Assignment criterion #2 already updated; `decision-record.md` Decision 3 explains the supersession. Earlier text under Decision 2 is kept verbatim as historical record so the supersession is auditable. No silent rewrite. |
| Shared `meta` table init ordering | Each module owns its keys; `meta` uses `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`. Order-independent. |
| Session DB not initialized in CLI | CLI explicitly calls `initSessionDb()` before attribution. Tests inject DB handles. |
| Dashboard build excluded from root `npm run typecheck` | Verification step adds `npm run build --prefix dashboard`. |
| `broadcast` parameter unused | Omitted from `createUsageRouter()` signature in v1. |
| Sessions index for fuzzy fallback | Not added in v1; size of `sessions` is small. Documented as a follow-up optimization. |

## Testing Strategy

- **Unit (vitest):** one test file per module, tmp-dir DB via `mkdtemp`, explicit `resetUsageDb()` + `closeUsageDb()` per `proof-db.test.ts` pattern (no `closeAll` helper).
- **Fixtures:** flat JSON for ccusage at `src/__tests__/fixtures/ccusage-session.json`; `cwd/{claude,codex}/` subdir for the JSONL pair. **The ccusage fixture must be a real `ccusage session --json --breakdown` capture** (no synthesized stub). Header comment records `ccusage --version` and capture date.
- **Integration smoke (manual):** `npm run build && node dist/index.js usage --json` against a temp-seeded DB; visit `/usage` after `syntaur dashboard --dev` (NOT `npm run dev`).
- **Coverage:** every public function in tasks 1-5 has at least one happy-path and one edge-case test. ENOENT path, ISO/SQLite-datetime mix, cross-UTC-day regression, unattributed cwd, atomic last_run advance — all covered explicitly.

## Sequencing

`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`. Test files land alongside each module (test files in task 8's table are scaffolding — the real test writes happen during their respective module tasks).

## Verification Commands

```bash
npm run typecheck                       # src/ only
npm run build --prefix dashboard        # dashboard frontend tsc
npm test                                # vitest src/__tests__
npm run build && node dist/index.js usage --json
syntaur dashboard --dev                  # open /usage  (NOT `npm run dev`)
```

## Anti-hallucination notes

- All cited file paths exist in the worktree as of 2026-05-21 (verified by scout + plan-author Reads).
- Line numbers are approximate (`~line N`) where exact lines aren't load-bearing; load-bearing ones (`sessions.path`, `agent-sessions.ts:113`, codex test fixture `:30-34`, `index.ts:830-841` addCommand block, `server.ts:841-842` close block) are verified.
- The ccusage JSON field names ARE explicitly unpinned in this plan — implementation captures the real shape from a real `ccusage session --json` run before writing the parser.
- The originally-cited "Optional `CODEX_SESSIONS_DIR` already honored by the codex side" was scoped only to `platforms/codex/scripts/resolve-session.sh`; new TS code adds the env-override read explicitly.
