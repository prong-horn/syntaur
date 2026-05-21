# YouTube Research Toolkit — v1 Implementation

**Date:** 2026-05-21
**Complexity:** small
**Tech Stack:** TypeScript, Node 22+, pnpm workspaces, better-sqlite3, commander, Zod, simple-statistics, Hono, Vite + React, Vitest

**Canonical reference:** `/Users/brennen/syntaur/docs/superpowers/specs/2026-05-21-yt-research-design.md` — the spec is the source of truth for schema, metrics, quota model, and CLI surface. This plan sequences the build; if anything here conflicts with the spec, the spec wins.

## Objective
Stand up a greenfield monorepo at `~/yt-research` that ingests YouTube channel + recent-video data into SQLite, exposes analysis via CLI, and renders an explorer dashboard. Target a working v1 covering all six ingest commands (`seed`, `pull`, `refresh`, `import`, `expand`, `doctor`), all six analyze commands (`query`, `correlate`, `cohort`, `export`, `niches`, `topics`), three dashboard views, and Vitest coverage of parsers, stats, schemas, and HTTP endpoints.

## Writer-boundary clarification (the spec is ambiguous here — pinning it down)
- **Data tables** (`channels`, `videos`, `*_snapshots`, `channel_current`, `channel_seeds`, `ingest_events`, `quota_log`): only `ingest` writes.
- **Taxonomy tables** (`niches`, `channel_niches`, `channel_topics`): user-curation, not data.
  - `analyze`'s `niches` and `topics` subcommands open a narrow **write handle** scoped to these tables.
  - Dashboard server's `POST /api/channels/:id/niches` opens the same narrow write handle.
  - Their underlying writer functions all live in `core` so the rule is enforced in one place.
- **Views** are rebuilt by `ingest` after migrations run. `analyze` and the dashboard open the DB read-only and assume views exist; if missing, they error with a hint to run `yt-ingest doctor`.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `~/yt-research/package.json` | CREATE | Workspace root, scripts, devDeps |
| `~/yt-research/pnpm-workspace.yaml` | CREATE | Declare `packages/*` and `packages/dashboard/*` |
| `~/yt-research/tsconfig.base.json` | CREATE | Shared TS config (NodeNext, strict, ES2022) |
| `~/yt-research/.env.example` | CREATE | `YT_API_KEY=` template |
| `~/yt-research/.gitignore` | CREATE | `node_modules`, `data/yt.sqlite*`, `.env.local`, `dist/` |
| `~/yt-research/claude-info/plans/.gitkeep` | CREATE | Project convention for future plans |
| `~/yt-research/data/topics.yaml` | CREATE | Topic ID → human label seed file |
| `~/yt-research/scripts/dev.ts` | CREATE | Spawns Hono server + Vite dev server |
| `~/yt-research/packages/core/package.json` | CREATE | `@yt/core` lib |
| `~/yt-research/packages/core/src/index.ts` | CREATE | Re-export public surface |
| `~/yt-research/packages/core/src/types/*.ts` | CREATE | `Channel`, `Video`, `Snapshot`, `Niche`, `IngestEvent` |
| `~/yt-research/packages/core/src/errors.ts` | CREATE | Typed error hierarchy (5 classes from spec §10) |
| `~/yt-research/packages/core/src/config.ts` | CREATE | Zod-validated config loader (env > json > defaults) |
| `~/yt-research/packages/core/src/db/connection.ts` | CREATE | `openDb({ readonly })` with pragmas |
| `~/yt-research/packages/core/src/db/migrate.ts` | CREATE | Apply `migrations/NNNN_*.sql` in one tx; track in `meta` |
| `~/yt-research/packages/core/src/db/migrations/0001_initial.sql` | CREATE | All tables + indexes from spec §4 |
| `~/yt-research/packages/core/src/db/migrations/0002_views.sql` | CREATE | `v_channel_metrics`, `v_video_age_buckets` (DROP+CREATE on startup via migrate helper) |
| `~/yt-research/packages/core/src/db/views.ts` | CREATE | Rebuild views on every startup |
| `~/yt-research/packages/core/src/youtube/client.ts` | CREATE | `YouTubeClient` — fetch + Zod validation + retry |
| `~/yt-research/packages/core/src/youtube/quota.ts` | CREATE | `QuotaTracker` — LA-date bucketed reads/writes against `quota_log` |
| `~/yt-research/packages/core/src/youtube/cost-map.ts` | CREATE | Endpoint → unit cost (search=100, others=1) |
| `~/yt-research/packages/core/src/youtube/schemas.ts` | CREATE | Zod schemas for `channels.list`, `videos.list`, `playlistItems.list`, `search.list`, `channelSections.list` responses |
| `~/yt-research/packages/core/src/youtube/duration.ts` | CREATE | ISO 8601 → seconds parser |
| `~/yt-research/packages/core/src/stats/index.ts` | CREATE | Pearson, Spearman, quantile wrappers around `simple-statistics` |
| `~/yt-research/packages/core/src/filter-dsl/parser.ts` | CREATE | Recursive-descent parser → AST |
| `~/yt-research/packages/core/src/filter-dsl/ast.ts` | CREATE | Zod-validated AST types |
| `~/yt-research/packages/core/src/filter-dsl/compile.ts` | CREATE | AST → `{ sql, params }` with whitelist |
| `~/yt-research/packages/core/src/filter-dsl/whitelist.ts` | CREATE | Single column whitelist used everywhere |
| `~/yt-research/packages/core/src/metrics.ts` | CREATE | Canonical metric definitions / null rules from spec §4 |
| `~/yt-research/packages/core/src/__tests__/*.test.ts` | CREATE | Unit tests: duration, filter DSL, stats, quota date bucketing |
| `~/yt-research/packages/core/src/youtube/__fixtures__/*.json` | CREATE | Captured response fixtures for ingest integration tests |
| `~/yt-research/packages/ingest/package.json` | CREATE | `@yt/ingest`, bin `yt-ingest` |
| `~/yt-research/packages/ingest/src/bin/yt-ingest.ts` | CREATE | Commander root, wires subcommands |
| `~/yt-research/packages/ingest/src/commands/seed.ts` | CREATE | search.list → channels.list batched |
| `~/yt-research/packages/ingest/src/commands/pull.ts` | CREATE | channels.list → playlistItems.list → videos.list |
| `~/yt-research/packages/ingest/src/commands/refresh.ts` | CREATE | Stalest-first re-pull with snapshot writes |
| `~/yt-research/packages/ingest/src/commands/import.ts` | CREATE | File parser; URL→ID/handle; batch IDs, one-at-a-time handles |
| `~/yt-research/packages/ingest/src/commands/expand.ts` | CREATE | channelSections.list collect singleplaylist/multiplechannels |
| `~/yt-research/packages/ingest/src/commands/doctor.ts` | CREATE | DB stats + today's quota + unresolved targets (0 units) |
| `~/yt-research/packages/ingest/src/writers.ts` | CREATE | Transactional inserts: channels/videos/snapshots/seeds/ingest_events |
| `~/yt-research/packages/ingest/src/__tests__/*.test.ts` | CREATE | Run each command against fixtures, assert DB state |
| `~/yt-research/packages/analyze/package.json` | CREATE | `@yt/analyze`, bin `yt` |
| `~/yt-research/packages/analyze/src/bin/yt.ts` | CREATE | Commander root for analyze |
| `~/yt-research/packages/analyze/src/commands/query.ts` | CREATE | Filter DSL → SQL against `v_channel_metrics`; table/json/csv |
| `~/yt-research/packages/analyze/src/commands/correlate.ts` | CREATE | Pearson/Spearman with optional groupBy |
| `~/yt-research/packages/analyze/src/commands/cohort.ts` | CREATE | Cohort comparison by published-after + niche + metric |
| `~/yt-research/packages/analyze/src/commands/export.ts` | CREATE | Whitelisted view export (csv/parquet) |
| `~/yt-research/packages/analyze/src/commands/niches.ts` | CREATE | add/list/tag against `niches` + `channel_niches` |
| `~/yt-research/packages/analyze/src/commands/topics.ts` | CREATE | list/label against `data/topics.yaml` |
| `~/yt-research/packages/analyze/src/__tests__/*.test.ts` | CREATE | DSL → SQL snapshots; correlate against known data |
| `~/yt-research/packages/dashboard/server/package.json` | CREATE | `@yt/dashboard-server`, Hono |
| `~/yt-research/packages/dashboard/server/src/index.ts` | CREATE | Hono app, binds `127.0.0.1:5273` |
| `~/yt-research/packages/dashboard/server/src/routes/channels.ts` | CREATE | GET list (filters via DSL), GET :id, POST :id/niches |
| `~/yt-research/packages/dashboard/server/src/routes/correlate.ts` | CREATE | GET /api/correlate |
| `~/yt-research/packages/dashboard/server/src/routes/cohort.ts` | CREATE | GET /api/cohort |
| `~/yt-research/packages/dashboard/server/src/__tests__/*.test.ts` | CREATE | Seeded DB + endpoint snapshots |
| `~/yt-research/packages/dashboard/web/package.json` | CREATE | `@yt/dashboard-web`, Vite + React |
| `~/yt-research/packages/dashboard/web/vite.config.ts` | CREATE | Proxy `/api` → `127.0.0.1:5273` |
| `~/yt-research/packages/dashboard/web/index.html` | CREATE | SPA shell |
| `~/yt-research/packages/dashboard/web/src/main.tsx` | CREATE | React entry |
| `~/yt-research/packages/dashboard/web/src/App.tsx` | CREATE | Router shell with three view tabs |
| `~/yt-research/packages/dashboard/web/src/views/Explorer.tsx` | CREATE | Scatter + filter sidebar + drawer trigger |
| `~/yt-research/packages/dashboard/web/src/views/ChannelDrawer.tsx` | CREATE | Detail panel with niche chips, sparklines, video table |
| `~/yt-research/packages/dashboard/web/src/views/Correlations.tsx` | CREATE | Small-multiples grid |
| `~/yt-research/packages/dashboard/web/src/lib/api.ts` | CREATE | Thin fetch wrapper for endpoints |

## Tasks

### 1. Scaffold the workspace
- **Files:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `data/topics.yaml`, `claude-info/plans/.gitkeep`
- **What:** Create `~/yt-research` directory. Initialize pnpm workspace with packages glob `packages/*` and `packages/dashboard/*`. Root `package.json` declares scripts: `test`, `build`, `dev`, `typecheck`. Add devDeps: `typescript@^5.5`, `vitest@^2`, `@types/node@^22`, `tsx`. Set `engines.node >= 22`. tsconfig.base uses `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, `composite: true`. Run `git init`.
- **Pattern:** Standard pnpm monorepo layout; spec §3 has the exact tree.
- **Verify:** `cd ~/yt-research && pnpm install` exits 0 and `pnpm -r exec tsc --noEmit` runs (no packages yet — succeeds trivially).

### 2. Build `core` — errors, types, config
- **Files:** `packages/core/{package.json,src/index.ts,src/errors.ts,src/config.ts,src/types/*.ts}`
- **What:** `package.json` name `@yt/core`, deps: `better-sqlite3`, `zod`, `simple-statistics`, `yaml`. `errors.ts` exports the five typed errors (spec §10). `config.ts` loads `.env.local` (via `dotenv`), merges with `~/.config/yt-research/config.json`, falls back to defaults (`dailyQuotaBudget: 9000`, `defaultVideoCount: 50`, `topicLabelsPath`, `dbPath`), validates with Zod. `types/` defines `Channel`, `Video`, `ChannelStatsSnapshot`, `VideoStatsSnapshot`, `Niche`, `IngestEvent` matching schema columns.
- **Pattern:** Class-based custom errors extending `Error` with `name` set on prototype; Zod `z.object` for config schema.
- **Verify:** `pnpm --filter @yt/core exec tsc --noEmit` passes.

### 3. Build `core/db` — connection, migrations, views, narrow-write helpers
- **Files:** `packages/core/src/db/{connection.ts,migrate.ts,views.ts,writers/taxonomy.ts,migrations/0001_initial.sql,migrations/0002_views.sql}`
- **What:** `connection.ts` exposes `openDb(path, { readonly })` that runs `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;` after open (skip `journal_mode` set on readonly). Also export `openTaxonomyWriter(path)` — a write handle that exposes only the helpers in `writers/taxonomy.ts` (used by `analyze` and the dashboard server). `migrate.ts` reads `migrations/*.sql` in order, applies any not in `meta.schema_version`, wraps in a single `BEGIN/COMMIT`. `0001_initial.sql` contains every CREATE TABLE + INDEX from spec §4 verbatim. `views.ts` runs DROP VIEW + CREATE VIEW for `v_channel_metrics` and `v_video_age_buckets`; called by `ingest` after migrations only. `0002_views.sql` is the canonical text. `writers/taxonomy.ts` exports `addNiche`, `tagChannelNiche`, `removeChannelNiche`, `setTopicLabel` — these are the ONLY way other packages mutate taxonomy tables.
- **Pattern:** Spec §4 SQL is canonical — paste it. `age_days` in `v_channel_metrics` is `(julianday('now') - julianday(channels.created_at))`.
- **Verify:** Migration test: open in-memory DB, run `migrate()`, assert all tables/indexes via `sqlite_master`. Run twice — second run is no-op. Boundary test: `openDb(..., { readonly: true })` rejects any INSERT/UPDATE.

### 4. Build `core/youtube` — client + quota + schemas + halt state
- **Files:** `packages/core/src/youtube/{cost-map.ts,quota.ts,schemas.ts,duration.ts,client.ts,halt.ts}` + `__fixtures__/*.json`
- **What:** `cost-map.ts` exports `{ 'search.list': 100, 'channels.list': 1, ... }`. `quota.ts` implements `QuotaTracker(db, budget)` with `today()` returning `YYYY-MM-DD` in `America/Los_Angeles` (use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`), `totalToday()`, `preflight(endpoint)` that:
  - throws `QuotaBudgetExceededError` (clean halt, exit 0) if the budget is locally exhausted; before throwing, writes `meta.key='resume_token'` with a JSON blob `{ command, args, lastProcessed }` so the next run can pick up where it left off
  - throws `QuotaHaltedError` (exit 2) if YouTube has actually returned `quotaExceeded` today (`meta.key='quota_halted_at'` is set for the current PT date)
- `record(endpoint, units)` upserts into `quota_log`. `halt.ts` exports `markQuotaHalted(db, requestId)` — sets `meta.quota_halted_at` AND writes an `ingest_events` row with `outcome='quota_halted'` and the YouTube request ID. `schemas.ts` defines Zod schemas for each endpoint's response shape — only the fields we read. `duration.ts` parses ISO 8601 `PT#H#M#S` → seconds. `client.ts` exports `YouTubeClient` with methods `searchChannels(q, max)`, `listChannels(ids)`, `listChannelsByHandle(handle)`, `listVideos(ids)`, `listPlaylistItems(playlistId, pageToken?)`, `listChannelSections(channelId)`. Each method:
  1. preflight quota
  2. fetch (capture `X-Goog-Request-Id` / `x-request-id` from response headers)
  3. on HTTP response: record quota; on transport failure: no debit
  4. Zod validate; drift → `SchemaValidationError` with full response payload + request ID logged
  5. retry up to 3 on 5xx + 403 `rateLimitExceeded` with exponential backoff
  6. hard fail on 403 `quotaExceeded` → call `markQuotaHalted` and throw `QuotaHaltedError`
- All thrown errors carry `requestId` when available (spec §10).
- Batch helpers chunk IDs to 50.
- **Pattern:** Single fetch wrapper inside the class; per-method just composes URL + cost key. The wrapper is the only place errors are constructed.
- **Verify:** Unit test duration parser (`PT1H2M3S` → 3723; `PT45S` → 45). Unit test quota tracker (mock clock, assert LA date boundary; assert `resume_token` written on budget exhaustion; assert `QuotaHaltedError` when `quota_halted_at` is set for today). Unit test client against fixtures: mock `fetch`, drive a `listVideos` call, assert (a) quota debit on 200 and 400, (b) no debit on `fetch` throw, (c) `markQuotaHalted` invoked on `quotaExceeded`, (d) `requestId` propagated to thrown errors.

### 5. Build `core/stats` and `core/filter-dsl`
- **Files:** `packages/core/src/stats/index.ts`, `packages/core/src/filter-dsl/{parser.ts,ast.ts,compile.ts,whitelist.ts}`, `packages/core/src/metrics.ts`
- **What:** `stats/index.ts` re-exports `pearson`, `spearman`, `quantile` from `simple-statistics` with NaN/length guards. `whitelist.ts` exports a `const COLUMN_WHITELIST` set covering every column referenced in `v_channel_metrics` plus `niche`, `country`, `topic_id`. `ast.ts` defines Zod-validated AST node types (`Binary`, `Comparison`, `Not`, `In`, `Like`). `parser.ts` is hand-written recursive-descent for the grammar in spec §6 — tokenize, then `expr := term (AND|OR term)*` etc. `compile.ts` walks the AST and emits `{ sql: string, params: any[] }` using parameterized placeholders; rejects any column not in whitelist with a typed error. `metrics.ts` exports the canonical metric registry from spec §4 with null/edge rules encoded as SQL fragments.
- **Pattern:** Never interpolate user strings into SQL — bind every literal as a placeholder.
- **Verify:** Unit tests for parser (round-trip the example `subscriber_count>10000 AND views_per_subscriber>0.05 AND niche="finance"` and snapshot the SQL). Stats tests against `simple-statistics` known fixtures.

### 6. Build `ingest` package and writers
- **Files:** `packages/ingest/{package.json,src/bin/yt-ingest.ts,src/writers.ts,src/commands/*.ts}`
- **What:** Add `@yt/core` workspace dep + `commander`. Bin shebang `#!/usr/bin/env node`. Every command: load config, `openDb({ readonly: false })`, run migrations + rebuild views, instantiate client + quota tracker, run in try/catch mapping each typed error to an exit code (spec §10). `writers.ts` exports transactional insert helpers (`upsertChannel`, `insertChannelSnapshot` + mirror into `channel_current`, `upsertVideo`, `insertVideoSnapshot`, `recordSeed`, `recordIngestEvent`). **All hard YouTube errors and skip decisions go through `recordIngestEvent`** — the full `outcome` set (`ok`, `not_found`, `private`, `handle_unresolved`, `video_unhydrated`, `schema_drift`, `rate_limited`, `quota_halted`, `transport_error`) is mapped from typed errors at each command's call site. Every event row includes the YouTube `requestId` in `detail` when available.
  - `seed`: search.list → collect channel IDs → batch channels.list 50 at a time → upsert + seed rows kind=`search`. Record `not_found` / `private` per channel ID missing from the batch response.
  - `pull`: resolve handle if `@`-prefixed (forHandle, one call; on empty result → `handle_unresolved` event, skip), else channels.list by id (on empty → `not_found`). Pull uploads playlist ID, paginate `playlistItems.list` up to `--videos`, then batched `videos.list`. For any playlist item video ID missing from videos.list response → `video_unhydrated` event, skip. Write `channel_stats_snapshots` + mirror, `video_stats_snapshots` for re-pulls.
  - `refresh`: query channels ordered by `last_pulled_at ASC` older than `--older-than` (default 7d), limit `--limit`. **Skip channels that have an unresolved hard-failure event in `ingest_events` within the last 24h** (outcomes: `not_found`, `private`, `handle_unresolved`) — re-runs don't waste quota on known-bad targets. Override with `--include-failed`.
  - `import`: read file lines; URL parsing local (regex `youtube.com/channel/UC...` or `youtube.com/@handle`); batch UC IDs, resolve handles one-by-one; then pull each. Per-line failure recorded as `ingest_events` with the input line as `target`.
  - `expand`: channelSections.list, filter `type IN ('singleplaylist','multiplechannels')`, collect `contentDetails.channels[]`, queue pulls.
  - `doctor`: print DB row counts, today's quota by endpoint, schema version, **unresolved ingest_events grouped by outcome**, and whether `meta.resume_token` or `meta.quota_halted_at` is set. Zero quota.
- **Pattern:** Each command is `export function register(program: Command) { program.command('seed').option(...).action(...) }`. Single shared init helper.
- **Verify:** Run each command against fixture JSON (mock client), assert DB state. Tests include: handle resolution failure → `handle_unresolved` event; playlist item missing in videos batch → `video_unhydrated` event; refresh skips a channel with a recent `not_found` event unless `--include-failed`. `pnpm --filter @yt/ingest test` green.

### 7. Build `analyze` package
- **Files:** `packages/analyze/{package.json,src/bin/yt.ts,src/commands/*.ts}`
- **What:** `@yt/core` workspace dep + `commander`. **Read query commands use `openDb(path, { readonly: true })`. Taxonomy mutations (`niches add/tag`, `topics label`) use the narrow `openTaxonomyWriter` helper from `core/db` — no direct INSERT/UPDATE outside that helper.** Views are NOT rebuilt here — ingest owns view rebuilds; if views are missing, error with "run yt-ingest doctor". Commands:
  - `query`: parse filter DSL, compile to SQL against `v_channel_metrics`, append `ORDER BY <whitelist col>` and `LIMIT`, render table (default) / json / csv.
  - `correlate`: pick X+Y from metric registry, optional `--group-by` returns one row per group; emit Pearson + Spearman + sample count.
  - `cohort`: **accepts a filter expression in the shared DSL** (e.g. `niche="finance" AND published_at>2024-01-01`), plus `--metric <name>` and `--bucket video-age|published-year`. Reuses `core/filter-dsl/compile.ts` exactly — no separate parameter parser.
  - `export <view>`: whitelist of view names (enumerated `const`), `--format csv|parquet` — **both required for v1**. CSV via manual writer; Parquet via `parquetjs-lite` (small, no native deps). Stream to `--out` or stdout.
  - `niches`: subcommands `add` (insert via `addNiche` with optional `--parent`), `list` (print tree), `tag <channel> <niche>` (`tagChannelNiche` with `source='manual'`). All writes go through `writers/taxonomy.ts`.
  - `topics`: `list` reads `data/topics.yaml`, `label <topic-id> <label>` rewrites yaml via `setTopicLabel`.
- **Pattern:** `cli-table3` for table output. CSV via manual writer (no extra dep). The `cohort` command imports the same parser/compile used by `query` to satisfy spec §6's "same filter DSL".
- **Verify:** DSL → SQL snapshots (cohort and query share fixtures). Correlate test against seeded DB with known correlation. Parquet export round-trip: write → read back → row count + schema match. Niches tag test asserts the row appears via the read-only handle in a subsequent query. `pnpm --filter @yt/analyze test` green.

### 8. Build dashboard server (Hono)
- **Files:** `packages/dashboard/server/{package.json,src/index.ts,src/routes/*.ts,src/__tests__/*.test.ts}`
- **What:** Deps `hono`, `@hono/node-server`, `@yt/core`. `index.ts` opens read-only DB + a separate write handle (used only by `channels.ts` for `POST :id/niches`). Bind `127.0.0.1:5273`. Routes:
  - `GET /api/channels`: parse query-string filter via DSL, paginate, return list with `subscriber_count, views_per_day, niches`.
  - `GET /api/channels/:id`: full channel + last 50 videos + snapshot history + niche tags.
  - `POST /api/channels/:id/niches`: body `{ add?: string[], remove?: string[] }`; insert/delete `channel_niches` rows with `source='manual'` in a tx using the write handle.
  - `GET /api/correlate`: query params `x`, `y`, `method`, `groupBy`; pull rows, run stats, return `{ pearson, spearman, points }`.
  - `GET /api/cohort`: accepts a `filter` query-string param parsed by the shared DSL (identical to `yt cohort`) plus `metric` and `bucket`; returns bucketed metric.
  - Errors map to status codes: `SchemaValidationError` → 500, `NotFoundError` → 404, DSL parse errors → 400.
- **Pattern:** One route file per resource; each exports a `Hono` sub-app mounted in `index.ts`.
- **Verify:** Seed an in-memory SQLite, boot Hono via `serve`, hit each endpoint with `fetch`, snapshot JSON. `pnpm --filter @yt/dashboard-server test` green.

### 9. Build dashboard web (Vite + React)
- **Files:** `packages/dashboard/web/{package.json,vite.config.ts,index.html,src/main.tsx,src/App.tsx,src/lib/api.ts,src/views/*.tsx}`
- **What:** Deps `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, plotting lib (pick `recharts` if simpler; `visx` if more layout control needed — decide at first scatter implementation, document choice in `web/README.md`). `vite.config.ts` proxies `/api` → `http://127.0.0.1:5273`. `App.tsx` is a tab shell: Explorer | Correlations. `Explorer.tsx`: scatter (X/Y metric pickers, color by niche/topic/country), **hover tooltips showing channel title + the X/Y values + sub count**, sidebar filters (subs range, age range, niche multi-select, country IN), click point → open `ChannelDrawer`. `ChannelDrawer.tsx`: header stats, uploads-over-time sparkline (group videos by month), **sortable recent videos table** (click column header to sort by `published_at`, `view_count`, `duration_sec`, `like_count`), per-row view trajectory sparkline if `video_stats_snapshots` has ≥2 rows, editable niche chip input that POSTs `/api/channels/:id/niches`. `Correlations.tsx`: pick N metrics, render an N×N grid of mini scatters with Pearson + Spearman labels; niche filter dropdown.
- **Pattern:** Functional components + hooks; `useEffect` fetch + local state, no global store. Show a small "samples not panel data" tag on video trajectory sparklines (spec §12).
- **Verify:** `pnpm --filter @yt/dashboard-web build` succeeds; `pnpm --filter @yt/dashboard-web exec tsc --noEmit` passes.

### 10. Wire `scripts/dev.ts` + root scripts
- **Files:** `~/yt-research/scripts/dev.ts`, root `package.json` scripts
- **What:** `dev.ts` uses `node:child_process` to spawn `pnpm --filter @yt/dashboard-server dev` and `pnpm --filter @yt/dashboard-web dev` in parallel, forwarding stdio. Root scripts: `"dev": "tsx scripts/dev.ts"`, `"test": "pnpm -r test"`, `"typecheck": "pnpm -r exec tsc --noEmit"`, `"build": "pnpm -r build"`.
- **Pattern:** Simple `spawn` with `stdio: 'inherit'`; ctrl-c kills both.
- **Verify:** `pnpm dev` brings up server on 5273 and Vite on its default port; browser loads `/`.

### 11. Verification — CI gate + optional live smoke
- **Files:** none — verification only
- **Required for v1 sign-off (no network):**
  1. `pnpm install && pnpm typecheck` — all green.
  2. `pnpm test` — Vitest passes across all packages with NO live API access (spec §11: integration tests use recorded fixtures only).
  3. `pnpm --filter @yt/dashboard-web build` succeeds.
  4. `pnpm --filter @yt/ingest exec yt-ingest doctor` against an empty DB — prints empty stats, 0 quota.
- **Optional live-API smoke (manual, with a real key):**
  1. `cp .env.example .env.local`, fill `YT_API_KEY`.
  2. `yt-ingest seed --query "personal finance" --max 10` — ~101 units.
  3. `yt-ingest pull <one-channel-id> --videos 25` — ~3 units.
  4. `yt query 'subscriber_count>1000' --limit 5` — returns rows.
  5. `yt correlate subscriber_count views_per_day` — returns Pearson + Spearman.
  6. `pnpm dev` — Explorer renders, drawer opens, niche chip add persists across reload.
  Document the smoke checklist in `~/yt-research/README.md` so the user can run it when they have a key; it is not gated by the test suite.

## Dependencies
- Node 22+ and pnpm installed.
- A YouTube Data API v3 key (free tier 10k units/day) in `.env.local`.
- No env vars beyond `YT_API_KEY`; user-tunable defaults live in `~/.config/yt-research/config.json`.
- Risks tracked from spec §12 to surface as UI labels or `ingest_events` rows — not blockers:
  - Opportunistic video snapshots labeled as samples (not panel data) in `ChannelDrawer`.
  - `short_heuristic` is duration-only (≤180s); no aspect-ratio detection.
  - `topicDetails.topicIds` deprecated — `channel_topics` is weak metadata.
  - March 2025 Shorts view-count semantic shift — v1 does NOT normalize.
  - `hiddenSubscriberCount=true` → subs NULL; YouTube rounds counts ≥1k.
  - Handles cannot be batched — `forHandle` is one-at-a-time.
  - Partial hydration → `outcome='video_unhydrated'` in `ingest_events`.
  - Plotting lib choice (visx vs recharts) deferred to first scatter implementation; document in `web/README.md`.

## Verification
```
# Required (offline) gate:
cd ~/yt-research
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @yt/dashboard-web build
pnpm --filter @yt/ingest exec yt-ingest doctor

# Optional live smoke (requires YT_API_KEY):
pnpm --filter @yt/ingest exec yt-ingest seed --query "personal finance" --max 10
pnpm --filter @yt/ingest exec yt-ingest pull <channel-id-from-step-above> --videos 25
pnpm --filter @yt/analyze exec yt query 'subscriber_count>1000' --limit 5
pnpm --filter @yt/analyze exec yt correlate subscriber_count views_per_day
pnpm dev   # then load http://localhost:5173
```
Required commands exit 0; dashboard renders Explorer (with hover tooltips), Channel drawer (with sortable video table), and Correlations grid against the seeded data after live smoke.
