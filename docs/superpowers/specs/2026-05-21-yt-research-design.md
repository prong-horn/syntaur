# YouTube Research Tooling — Design

**Status:** Draft v2 — codex review applied, pending final user review
**Date:** 2026-05-21
**Goal:** Standalone TS toolkit to ingest YouTube channel + recent-video data into SQLite and explore it for correlations ("what works") via a CLI and a small local dashboard.

## 1. Goals & Non-Goals

### Goals
- Collect channel-level and recent-video data (last 50 videos per channel) for thousands of channels.
- Seed channels three ways: keyword search, manual list / external CSV import, and "expand" from existing channels' featured channels (via `channelSections.list`).
- Slice, filter, and correlate metrics across the dataset (CLI + dashboard).
- Track time-series stats *opportunistically* — only when the user re-pulls a channel.
- Respect the YouTube Data API v3 free-tier quota (10,000 units/day) with a clean halt-and-resume model.

### Non-Goals
- Scheduled background ingestion (no cron, no daemon).
- Multi-user / hosted deployment. Localhost-only.
- Heavy NLP on titles/descriptions (out of scope for v1; data is captured so it can be added).
- Live YouTube playback or embedding.

## 2. Stack

- **Language:** TypeScript end-to-end.
- **Runtime:** Node 22+, pnpm workspaces.
- **Storage:** SQLite via `better-sqlite3`.
- **CLIs:** `commander` (or `cac`).
- **Validation:** Zod for API response shapes and CLI flag parsing.
- **Stats:** `simple-statistics` for Pearson / Spearman / quantiles.
- **Dashboard server:** Hono.
- **Dashboard UI:** Vite + React + TypeScript. Plotting via `visx` or `recharts` (decided at implementation).
- **Tests:** Vitest.

Why this stack: it matches the existing Syntaur tooling (Brennen's day-to-day repo), keeps one language across CLI and dashboard, and the dataset is small enough (< 10M rows realistic) that SQLite handles it trivially. If correlation work ever outgrows `simple-statistics`, the SQLite file is exportable to a Python notebook in one step.

## 3. Repository Layout

```
yt-research/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example              # YT_API_KEY=...
├── data/
│   ├── yt.sqlite             # gitignored
│   └── topics.yaml           # YT topicDetails Freebase IDs → human labels
├── packages/
│   ├── core/                 # shared library, no side effects on import
│   │   ├── youtube/          # API client + quota tracker
│   │   ├── db/               # better-sqlite3 + migrations
│   │   ├── types/            # Channel, Video, Snapshot, Niche
│   │   ├── stats/            # correlation utilities
│   │   └── schema.sql
│   ├── ingest/               # CLI: writes to DB
│   │   └── bin/yt-ingest.ts  # seed | pull | refresh | import | expand
│   ├── analyze/              # CLI: reads from DB
│   │   └── bin/yt.ts         # query | correlate | cohort | export | niches
│   └── dashboard/
│       ├── server/           # Hono server, read-only SQLite (+ niche writes)
│       └── web/              # Vite + React SPA
└── scripts/
    └── dev.ts                # spins up dashboard locally
```

### Package boundaries
- `core` is the **only** package that opens the DB or talks to the YouTube API. Other packages import from `core`.
- `ingest` is the **only** writer for ingest-side tables (channels, videos, snapshots, quota_log, seeds).
- `analyze` and `dashboard/server` read everything; the dashboard server is the only other writer, limited to `channel_niches` (user tagging from the UI).
- Each package can be type-checked, tested, and built independently.

## 4. Data Schema

SQLite. Migrations live in `core/db/migrations/NNNN_*.sql`, applied in a single transaction at startup. Schema version tracked in a `meta` table.

```sql
-- Channel identity (rarely changes)
CREATE TABLE channels (
  id              TEXT PRIMARY KEY,         -- UC... YouTube channel ID
  handle          TEXT,                     -- @handle (nullable)
  title           TEXT NOT NULL,
  description     TEXT,
  country         TEXT,                     -- ISO-3166 alpha-2
  created_at      TEXT NOT NULL,            -- channel's own publishedAt
  custom_url      TEXT,
  thumbnail_url   TEXT,
  first_pulled_at TEXT NOT NULL,            -- when WE first saw it
  last_pulled_at  TEXT NOT NULL
);

-- Channel time-series (one row per opportunistic re-pull)
CREATE TABLE channel_stats_snapshots (
  channel_id       TEXT NOT NULL REFERENCES channels(id),
  pulled_at        TEXT NOT NULL,
  subscriber_count INTEGER,
  view_count       INTEGER,
  video_count      INTEGER,
  PRIMARY KEY (channel_id, pulled_at)
);

-- Latest snapshot, mirrored for fast filtering/sorting
CREATE TABLE channel_current (
  channel_id       TEXT PRIMARY KEY REFERENCES channels(id),
  subscriber_count INTEGER,
  view_count       INTEGER,
  video_count      INTEGER,
  updated_at       TEXT NOT NULL
);

-- Video identity + latest stats
CREATE TABLE videos (
  id                  TEXT PRIMARY KEY,
  channel_id          TEXT NOT NULL REFERENCES channels(id),
  title               TEXT NOT NULL,
  description         TEXT,                 -- captured for future NLP, nullable
  category_id         INTEGER,              -- YouTube videoCategory ID
  tags_json           TEXT,                 -- JSON array of tags (nullable; not always returned)
  published_at        TEXT NOT NULL,
  duration_sec        INTEGER NOT NULL,     -- parsed from ISO 8601
  short_heuristic     INTEGER NOT NULL,     -- 1 if duration_sec <= 180 (post-Oct 2024 Shorts limit).
                                            -- Heuristic only: the Data API does not expose
                                            -- aspect ratio or the actual Shorts flag.
  view_count          INTEGER,
  like_count          INTEGER,
  comment_count       INTEGER,
  pulled_at           TEXT NOT NULL
);
CREATE INDEX idx_videos_channel ON videos(channel_id);
CREATE INDEX idx_videos_published ON videos(published_at);

-- Video time-series (opportunistic, only on channel re-pull)
CREATE TABLE video_stats_snapshots (
  video_id      TEXT NOT NULL REFERENCES videos(id),
  pulled_at     TEXT NOT NULL,
  view_count    INTEGER,
  like_count    INTEGER,
  comment_count INTEGER,
  PRIMARY KEY (video_id, pulled_at)
);

-- User-defined niches (primary taxonomy)
CREATE TABLE niches (
  id        INTEGER PRIMARY KEY,
  name      TEXT UNIQUE NOT NULL,
  parent_id INTEGER REFERENCES niches(id)
);
CREATE TABLE channel_niches (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  niche_id   INTEGER NOT NULL REFERENCES niches(id),
  source     TEXT NOT NULL,    -- 'manual' | 'seed-query' | 'topic-id'
  PRIMARY KEY (channel_id, niche_id)
);

-- YouTube's own topicDetails (separate from user niches).
-- NOTE: topicDetails.topicIds is deprecated; Google now returns a small curated set.
-- Treat as weak metadata, not a stable taxonomy.
CREATE TABLE channel_topics (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  topic_id   TEXT NOT NULL,     -- Freebase-style ID, e.g. /m/02jjt
  PRIMARY KEY (channel_id, topic_id)
);

-- Provenance: how each channel entered the dataset
CREATE TABLE channel_seeds (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  kind       TEXT NOT NULL,     -- 'manual' | 'search' | 'import' | 'related'
  query      TEXT,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (channel_id, kind, query)
);

-- Daily quota ledger (drives halt-and-resume).
-- `date` is the calendar date in America/Los_Angeles — matches Google's documented
-- midnight-PT quota reset boundary. See §7.
CREATE TABLE quota_log (
  date     TEXT NOT NULL,        -- YYYY-MM-DD in America/Los_Angeles
  endpoint TEXT NOT NULL,
  units    INTEGER NOT NULL,
  PRIMARY KEY (date, endpoint)
);

-- Ingestion provenance: failures and partial hydrations.
-- Recorded per (operation, target) so we can audit "why isn't this channel/video here?"
CREATE TABLE ingest_events (
  id         INTEGER PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  operation  TEXT NOT NULL,       -- 'seed' | 'pull' | 'refresh' | 'import' | 'expand'
  target     TEXT NOT NULL,       -- channelId, handle, video ID, or input line
  outcome    TEXT NOT NULL,       -- 'ok' | 'not_found' | 'private' | 'handle_unresolved'
                                  -- | 'video_unhydrated' | 'schema_drift' | 'rate_limited'
                                  -- | 'quota_halted' | 'transport_error'
  detail     TEXT                  -- free text / JSON error payload
);
CREATE INDEX idx_ingest_events_target ON ingest_events(target);

-- Schema version
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Computed views (rebuilt at startup)
- `v_channel_metrics` — joins `channel_current` + `age_days` + per-channel aggregates from `videos`: `avg_views`, `median_views`, `views_per_subscriber`, `uploads_per_month_90d`, `avg_duration_sec`, `pct_short_heuristic`. If ≥2 snapshots exist, also `growth_subs_30d`, `growth_views_30d`.
- `v_video_age_buckets` — bins videos by age (0–7d, 8–30d, 31–90d, 91–365d, >365d) for cohort comparisons.

### Canonical success metrics (the targets of "what works")
Defined once so the analysis layer has stable targets and the dashboard isn't computing them ad hoc.

| Metric | Definition | Null/edge handling |
|---|---|---|
| `subscriber_count` | Latest reported subs from `channel_current` | NULL when hiddenSubscriberCount=true. Counts are rounded by YouTube for channels ≥1k subs; treated as approximate. |
| `views_per_day` | `view_count / max(age_days, 1)` | Skip channels with `age_days < 30` from cohort comparisons. |
| `views_per_subscriber` | `view_count / NULLIF(subscriber_count, 0)` | NULL when subscriber_count is NULL or 0. Excluded from correlations by default. |
| `median_recent_views` | Median `view_count` across the stored last-N videos | Requires ≥5 videos; otherwise NULL. |
| `recent_uploads_per_month` | Count of videos with `published_at` in last 90d × (30/90) | Always defined; 0 when no recent uploads. |
| `growth_subs_30d` | `(subs_now − subs_30d_ago) / subs_30d_ago` from `channel_stats_snapshots` | Requires snapshots ≥25 days apart; otherwise NULL. |

Per YouTube's March 31, 2025 change, public Shorts view counts now reflect a different definition than long-form views. We treat `view_count` as one metric per video without per-format normalization in v1, but the spec acknowledges the shift.

### Why the denormalized `channel_current`
Avoids correlated subqueries against `channel_stats_snapshots` for every list query. Updated in the same transaction as the snapshot insert. Tradeoff: tiny duplication for big query simplicity.

## 5. Ingestion CLI (`yt-ingest`)

Quota costs are **per call** for each list endpoint (1 unit), except `search.list` which is 100 units per call. There is no per-`part` multiplier.

| Command | Description | Quota |
|---|---|---|
| `seed --query "<q>" [--max 50]` | `search.list` (channel-type) → channel IDs → batched `channels.list` (50 IDs/call) → store with `channel_seeds.kind='search'`. Search snippets are never treated as canonical channel rows. | 100 (search) + 1 per 50 channels |
| `pull <channelId\|@handle> [--videos 50]` | `channels.list` (1) → uploads playlist ID → `playlistItems.list` (1 per 50 items) → batched `videos.list` (1 per 50 IDs) | 3–4 per channel |
| `refresh [--older-than 7d] [--limit N]` | Re-pulls stalest channels first; writes new snapshot rows | same as pull |
| `import <file>` | One channel ID / `@handle` / channel URL per line. Resolution rules: URLs are parsed locally to either a UC ID or `@handle`; IDs are resolved in batches of 50 via `channels.list?id=`; handles are resolved one-at-a-time via `channels.list?forHandle=` (the API does not batch handles). Each pulled channel then incurs normal pull cost. | 1 per 50 IDs + 1 per handle + pull cost per channel |
| `expand <channelId>` | `channelSections.list` (`part=contentDetails`) → for sections of type `singleplaylist`/`multiplechannels`, collect `contentDetails.channels[]` and queue. | 1 per channel + pull cost per discovered channel |
| `doctor` | Reports DB stats, today's quota usage, schema version, and unresolved targets in `ingest_events`. | 0 |

**Partial hydration & failure rules:**
- `playlistItems.list` may return items whose video IDs do not hydrate in `videos.list` (deleted, private, region-blocked). The unhydrated IDs are recorded as `ingest_events.outcome='video_unhydrated'` and skipped.
- Handle resolution returning no channel writes `outcome='handle_unresolved'` and the target is skipped (not retried in the same run).
- All hard YouTube errors are recorded in `ingest_events` so re-running a `refresh` can skip known-bad targets.

Every command:
1. Loads `.env.local` for `YT_API_KEY`.
2. Opens DB, runs pending migrations.
3. Checks daily quota budget (default 9000/10000, configurable). On exceed, exits cleanly with a "resume tomorrow" message and a SQLite-stored resume token (`meta.key='resume_token'`).
4. Wraps writes in transactions.

## 6. Analysis CLI (`yt`)

```
yt query   [filter-expr] [--sort col] [--limit N] [--format table|json|csv]
yt correlate <metric-x> <metric-y> [--method pearson|spearman] [--group-by niche|topic|country]
yt cohort  --published-after 2024-01-01 --niche finance --metric views-per-day
yt export  <table|view> [--format csv|parquet] [--out path]
yt niches  [add <name> [--parent <name>] | list | tag <channel> <niche>]
yt topics  [list | label <topic-id> <label>]
```

### Filter DSL
Used by `yt query` and `yt cohort`, and by the dashboard's `/api/channels` filters (same parser, same whitelist).

```
expr     := term (AND|OR term)*
term     := col op value | NOT term | "(" expr ")"
op       := = | != | > | >= | < | <= | IN | LIKE
value    := number | "string" | (val1, val2, ...)
col      := IDENT                 -- must be in the column whitelist
```

Parsed by a hand-written recursive-descent parser into a Zod-validated AST, then compiled to parameterized SQL. **No string interpolation into SQL.** Arithmetic between columns is **not** supported in v1 — use pre-computed metrics (e.g. `views_per_subscriber`) instead.

**The same column whitelist applies everywhere a user can name a column**: filter DSL, `--sort`, `--group-by`, and `export <view>`. The `export` command takes a view name (not arbitrary table name); the whitelist of exportable views is enumerated in code.

Example: `subscriber_count>10000 AND views_per_subscriber>0.05 AND niche="finance"`.

### Built-in metrics for `yt correlate`
All metrics map to columns of `v_channel_metrics`. See §4 "Canonical success metrics" for exact definitions.
- `subscriber_count`, `view_count`, `video_count`, `age_days`
- `avg_views`, `median_recent_views`, `avg_duration_sec`
- `views_per_subscriber`, `views_per_day`, `recent_uploads_per_month`, `pct_short_heuristic`
- `growth_subs_30d`, `growth_views_30d` (require ≥2 snapshots ≥25d apart)

## 7. YouTube API Client & Quota

Single `YouTubeClient` class. Cost map (per Google's [Quota Cost calculator](https://developers.google.com/youtube/v3/determine_quota_cost), values current as of 2026-05):
- `search.list` — 100 units per call
- `channels.list`, `videos.list`, `playlistItems.list`, `channelSections.list` — 1 unit per call (not per part)
- All other read endpoints used here — 1 unit per call

### Per-call flow
1. Look up endpoint cost from the static cost map.
2. Read today's quota total. **Quota date = current calendar date in `America/Los_Angeles`**, matching Google's documented midnight-PT reset boundary.
3. If `current + cost > budget`, throw `QuotaBudgetExceededError` before any network call (clean halt; CLI exits with a "resume tomorrow" message).
4. Perform the call. Quota debiting (best-effort heuristic — Google does not expose actual debits per response):
   - **Transport failure** (DNS, timeout, no HTTP response): no debit.
   - **HTTP response received** (success or error from YouTube): debit the full cost. Google's docs say even invalid requests cost ≥1 unit; we don't try to carve out exceptions.
5. Retries: exponential backoff on 5xx and 403 `rateLimitExceeded` (this is the per-second rate limiter, distinct from daily `quotaExceeded`). Max 3 retries.
6. Hard fail on 403 `quotaExceeded` — record an `ingest_events` row with `outcome='quota_halted'`, set `meta.key='quota_halted_at'`, and exit with code 2.
7. Validate all responses through Zod schemas before returning. Drift surfaces as `SchemaValidationError`, not silent corruption.

### SQLite settings (applied on every connection)
- `PRAGMA journal_mode = WAL;` — concurrent readers + one writer.
- `PRAGMA synchronous = NORMAL;` — durable enough for a research DB, faster writes.
- `PRAGMA busy_timeout = 5000;` — block for up to 5s before returning `SQLITE_BUSY`.
- `PRAGMA foreign_keys = ON;`
- Read-only connections (dashboard, analyze CLI) open with `readonly: true`.

WAL allows the dashboard to read while ingest writes, but only one writer can hold a transaction at a time; the busy timeout absorbs short contention.

## 8. Dashboard

Hono server on port 5273. The server gets its DB handle from `core/db` (no direct `better-sqlite3` calls in the dashboard package) — read-only by default, with a separate write-handle used only for the niche-tagging endpoint. The Vite SPA at `/` consumes JSON endpoints.

### Endpoints
- `GET /api/channels` — paginated list with query-string filters (same column whitelist as the CLI filter DSL).
- `GET /api/channels/:id` — full channel detail with niche tags, recent videos, snapshot history.
- `POST /api/channels/:id/niches` — add/remove niche tags (only mutating endpoint).
- `GET /api/correlate?x=&y=&groupBy=` — Pearson + Spearman + raw points.
- `GET /api/cohort?...` — cohort comparison.

### Views
1. **Explorer (default):** Scatter plot, X/Y axis pickers from any metric. Color by niche or topic. Filter sidebar (subs range, age range, niche multi-select, country, country IN). Hover tooltip; click opens detail drawer.
2. **Channel drawer:** Header (avatar, title, key stats), uploads-over-time sparkline, recent videos table (sortable, with view trajectory sparkline if multiple snapshots exist), editable niche tag chips.
3. **Correlations:** Grid of small-multiples. For each pair of selected metrics, Pearson + Spearman + scatter. Filterable by niche to see how correlations shift across niches.

No auth. Server binds to `127.0.0.1` only.

## 9. Configuration & Secrets

- `.env.local` in repo root holds `YT_API_KEY`. Gitignored. `.env.example` checked in.
- `~/.config/yt-research/config.json` holds user-tunable defaults: `dailyQuotaBudget` (default 9000), `defaultVideoCount` (50), `topicLabelsPath` (default `data/topics.yaml`), `dbPath` (default `data/yt.sqlite`).
- Config loader: env > config.json > built-in defaults. Validated by Zod.

## 10. Error Handling

- **Typed error hierarchy** in `core/errors.ts`:
  - `QuotaBudgetExceededError` (clean exit, code 0, prints "resume tomorrow")
  - `QuotaHaltedError` (exit code 2, day's quota actually exhausted by YouTube)
  - `RateLimitedError` (retried internally; surfaces only after retries exhausted)
  - `NotFoundError` (channel/video doesn't exist or is private)
  - `SchemaValidationError` (Zod mismatch on YouTube response — log full payload for investigation)
- CLI commands map errors to exit codes; dashboard server maps them to HTTP statuses.
- All errors include the YouTube request ID where available, for debugging against Google's logs.

## 11. Testing

- **Unit:** ISO 8601 duration parser, filter DSL parser/compiler, Pearson/Spearman against known values, quota cost calculator, Zod schemas against captured fixtures.
- **Integration:** Each ingest command run against recorded YouTube API responses (saved JSON under `packages/core/youtube/__fixtures__/`). No live API in CI.
- **DB:** Migration tests — start from empty, apply all migrations, assert final schema. Also test idempotency.
- **Dashboard API:** Spin up Hono + a seeded SQLite, hit each endpoint, snapshot the JSON.
- Vitest across all packages with a single `pnpm test` at the root.

## 12. Open Questions / Future Work

- **Video time-series cadence** is currently coupled to channel re-pulls — trajectories will be irregular and channel-selection-biased. The dashboard must label these as opportunistic samples, not comparable panel data. If you eventually want true per-video tracking, add a `yt-ingest pull-video <id>` command on its own cadence.
- **Bulk seed expansion** — if you want to crawl outward beyond featured channels (e.g. related channels via comment authors), that's a separate ingester with much higher quota cost. Out of scope for v1.
- **Aspect-ratio-aware Shorts detection** — the public Data API does not expose aspect ratio, so `short_heuristic` is purely duration-based. If you ever need true Shorts identification, you'd need to scrape the watch page or use a third-party signal.
- **Per-format view normalization** — YouTube's March 31, 2025 change altered how Shorts views are counted. v1 does not normalize across formats.

## 13. Out of Scope (Explicit)

- Hosting / multi-user.
- Live OAuth flows (we use an API key, not OAuth — public data only).
- Anything requiring `youtubeAnalytics.v2` (that's first-party analytics, requires OAuth to the channel owner).
- Scheduled background jobs.
- Anything beyond the YouTube Data API v3 surface.
