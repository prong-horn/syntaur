# YouTube Research Tooling — Design

**Status:** Draft (pending user + codex review)
**Date:** 2026-05-21
**Goal:** Standalone TS toolkit to ingest YouTube channel + recent-video data into SQLite and explore it for correlations ("what works") via a CLI and a small local dashboard.

## 1. Goals & Non-Goals

### Goals
- Collect channel-level and recent-video data (last 50 videos per channel) for thousands of channels.
- Seed channels three ways: keyword search, manual list / external CSV import, and "expand" from existing channels' featured lists.
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
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels(id),
  title           TEXT NOT NULL,
  published_at    TEXT NOT NULL,
  duration_sec    INTEGER NOT NULL,         -- parsed from ISO 8601
  is_short        INTEGER NOT NULL,         -- duration_sec <= 60
  view_count      INTEGER,
  like_count      INTEGER,
  comment_count   INTEGER,
  pulled_at       TEXT NOT NULL
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

-- YouTube's own topicDetails (Freebase IDs), separate from user niches
CREATE TABLE channel_topics (
  channel_id TEXT NOT NULL REFERENCES channels(id),
  topic_id   TEXT NOT NULL,     -- Freebase ID, e.g. /m/02jjt
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

-- Daily quota ledger (drives halt-and-resume)
CREATE TABLE quota_log (
  date     TEXT NOT NULL,        -- YYYY-MM-DD, UTC (Google's reset boundary is midnight PT — see §7)
  endpoint TEXT NOT NULL,
  units    INTEGER NOT NULL,
  PRIMARY KEY (date, endpoint)
);

-- Schema version
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Computed views (rebuilt at startup)
- `v_channel_metrics` — joins `channel_current` + `age_days` + per-channel aggregates from `videos`: `avg_views`, `median_views`, `views_per_subscriber`, `uploads_per_month_90d`, `avg_duration_sec`, `pct_shorts`. If ≥2 snapshots exist, also `growth_subs_30d`, `growth_views_30d`.
- `v_video_age_buckets` — bins videos by age (0–7d, 8–30d, 31–90d, 91–365d, >365d) for cohort comparisons.

### Why the denormalized `channel_current`
Avoids correlated subqueries against `channel_stats_snapshots` for every list query. Updated in the same transaction as the snapshot insert. Tradeoff: tiny duplication for big query simplicity.

## 5. Ingestion CLI (`yt-ingest`)

| Command | Description | Quota |
|---|---|---|
| `seed --query "<q>" [--max 50]` | `search.list` → channel IDs → `channels.list` → store with `channel_seeds.kind='search'` | 100 + ~1/50 channels |
| `pull <channelId\|@handle> [--videos 50]` | `channels.list` → uploads playlist → `playlistItems.list` → `videos.list` in batches of 50 | ~3-5 per channel |
| `refresh [--older-than 7d] [--limit N]` | Re-pulls stalest channels first; writes new snapshot rows | same as pull |
| `import <file>` | One channel ID / `@handle` / channel URL per line. Resolves all to IDs in one `channels.list` batch (50/call), then pulls each. CSV ignored except first column. | ~1/50 + pull cost |
| `expand <channelId>` | Pulls `brandingSettings.featuredChannelsUrls`; queues each | minimal |
| `doctor` | Reports DB stats, quota usage today, schema version | 0 |

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
Used by `yt query` and `yt cohort`. Tiny expression grammar:

```
expr     := term (AND|OR term)*
term     := col op value | NOT term | "(" expr ")"
op       := = | != | > | >= | < | <= | IN | LIKE
value    := number | "string" | (val1, val2, ...)
```

Parsed by a hand-written recursive-descent parser into a Zod-validated AST, then compiled to parameterized SQL. **No string interpolation into SQL.** Column whitelist is enforced (`channels.country`, `v_channel_metrics.avg_views`, etc.).

Example: `subs>10000 AND avg_views/subs>0.05 AND niche="finance"`.

### Built-in metrics for `yt correlate`
- `subs`, `views`, `videos`, `age_days`
- `avg_views`, `median_views`, `avg_duration_sec`
- `views_per_subscriber`, `uploads_per_month_90d`, `pct_shorts`
- `growth_subs_30d`, `growth_views_30d` (require ≥2 snapshots)

## 7. YouTube API Client & Quota

Single `YouTubeClient` class. Every method:
1. Computes endpoint cost from a static cost map (`search.list=100`, `channels.list=1` per part returned, etc.).
2. Reads today's quota total (UTC date for now; **note**: Google's quota actually resets at midnight Pacific Time. v1 uses UTC for simplicity — accept that the budget may be off by up to one PT-day boundary. v2 can compute against PT properly).
3. If `current + cost > budget`, throws `QuotaBudgetExceededError` before any network call.
4. Performs the call. Quota debiting rule:
   - **Transport failure** (DNS, timeout, no HTTP response): no debit. YouTube wasn't reached.
   - **HTTP response received** (2xx, 4xx, or 5xx other than `quotaExceeded`): debit the full cost. YouTube charges for nearly all served responses.
   - **`quotaExceeded` 403**: no debit (the request was rejected pre-execution by Google's quota system).
5. Retries: exponential backoff on 5xx and 403 `rateLimitExceeded` (different from `quotaExceeded`). Max 3 retries.
6. Hard fail on 403 `quotaExceeded` — flips `meta.key='quota_halted_at'` and exits.
7. Validates all responses through Zod schemas before returning. Drift surfaces as a typed error, not silent corruption.

Quota cost reference baked into client: https://developers.google.com/youtube/v3/determine_quota_cost (values current as of 2026-05).

## 8. Dashboard

Hono server on port 5273 reads SQLite in read-only mode; serves JSON. The Vite SPA at `/` consumes those endpoints.

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

- **Video time-series cadence** is currently coupled to channel re-pulls. If you eventually want trajectory data on *one* viral video without re-pulling its whole channel, add a `yt-ingest pull-video <id>` command.
- **Bulk seed expansion** — if you want to crawl outward (related channels, comment-author channels), that's a separate ingester with much higher quota cost. Out of scope for v1.
- **PT-based quota boundary** — see §7. v1 uses UTC; v2 should compute against America/Los_Angeles.
- **Comments / transcripts / tags** — captured as nullable fields conceptually but not pulled in v1. Adding them is a flag on `pull`.

## 13. Out of Scope (Explicit)

- Hosting / multi-user.
- Live OAuth flows (we use an API key, not OAuth — public data only).
- Anything requiring `youtubeAnalytics.v2` (that's first-party analytics, requires OAuth to the channel owner).
- Scheduled background jobs.
- Anything beyond the YouTube Data API v3 surface.
