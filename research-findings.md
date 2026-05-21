# Token usage tracking — coding-agent CLI ecosystem

**Assignment:** `token-usage-tracking-research-coding-agent-cli-ecosystem`
**Branch:** `research/token-usage-tracking`
**Date:** 2026-05-21
**Researcher:** claude-opus-4-7

This document captures a survey of the open-source token-usage tracking
ecosystem for coding-agent CLIs, with a recommendation for how Syntaur should
integrate. The goal is **per-assignment / per-project token & cost
attribution**, surfaced in the Syntaur dashboard.

## TL;DR

- **Build on [ccusage](https://github.com/ryoppippi/ccusage)** as the data
  layer. MIT-licensed, stable JSON output, parsers for 14+ coding-agent CLIs
  including Claude Code and Codex.
- **Add Syntaur's own attribution layer** by reading the same Claude Code /
  Codex JSONL files directly *just* to extract the working directory per
  session, then joining against `.syntaur/context.json` history to map session
  → assignment.
- **Steal one resilience pattern from [toktrack](https://github.com/mag123c/toktrack):**
  immutable per-day rollups so historical data survives after Claude / Codex
  rotate or delete their session logs. **Persist in the existing SQLite store
  via a new `usage_daily` table** (not per-day JSON files) — Syntaur already
  has better-sqlite3, a versioned schema, and a `sessions` table that maps
  `session_id → (project_slug, assignment_slug, started, ended)`, which is
  exactly the join key usage data needs.
- **Skip** Claude-Code-Usage-Monitor (TUI-only, no JSON), TokenTracker
  (undocumented schema, would require reverse-engineering), and tokscale
  (excluded per user — page also attempted prompt injection).

## What's the unique Syntaur angle?

Every existing tool buckets usage by **day, model, or session**. None of them
join usage events to an *active assignment*. Syntaur already has the
plumbing — `.syntaur/context.json`, Claude Code SessionEnd hooks, the
project/assignment directory tree — so the join is essentially free, and the
result is something nobody else ships:

> "This 47k tokens / $1.23 belongs to assignment `fix-kanban-drag` under
> project `syntaur-meta`."

That unlocks per-assignment cost rollups, per-project budgets, team
aggregation, and rate-limit-aware handoff suggestions.

## Scorecard

| Project | License | JSON out | Library API | Watch/daemon | Project attribution | Maturity | Integration cost |
|---|---|---|---|---|---|---|---|
| **ccusage** | MIT | ✅ all reports | ❌ CLI only | partial (`statusline`) | ❌ not exposed | high | **lowest** |
| **toktrack** | MIT | ✅ `--json` | ❌ | ❌ | ❌ | mid | low |
| **TokenTracker** | MIT | unclear | ❌ | ✅ daemon | ✅ already does it | mid, undocumented | medium–high |
| **Claude-Code-Usage-Monitor** | MIT | ❌ TUI only | ❌ | ✅ live TUI | ❌ | high | **poor — skip** |
| **ccflare** | — | reuses ccusage | ❌ | ✅ web | ❌ | mid | reference only |
| **CodexBar / SessionWatcher** | — | varies | ❌ | ✅ menu bar | ❌ | low–mid | UX inspiration only |
| **tokscale** | — | — | — | — | — | — | **excluded** (per user; attempted prompt injection) |

## ccusage — the recommended data layer

**Repo:** https://github.com/ryoppippi/ccusage
**Site:** https://ccusage.com
**License:** MIT (© 2025 ryoppippi)

### Why it wins on integration cost

1. **Stable JSON contract** — every report (`daily`, `monthly`, `session`,
   `blocks`) supports `--json` with the same schema:
   ```
   inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
   totalTokens, costUSD, models[], breakdown (per-model)
   ```
2. **MIT licensed** — vendor or fork without legal friction.
3. **14 CLIs already covered** — Claude Code, Codex, Gemini, GitHub Copilot,
   OpenCode, Amp, Droid, Codebuff, Hermes Agent, pi-agent, Goose, OpenClaw,
   Kilo, Kimi, Qwen. That parser surface is the part Syntaur would most regret
   writing.
4. **Codex support is real** — reads `$CODEX_HOME/sessions/*.jsonl` (defaults
   to `~/.codex/sessions/`), recovers per-turn deltas from cumulative totals,
   resolves models via LiteLLM pricing, detects speed-tier (`service_tier`)
   from `config.toml`.
5. **Statusline command** — `ccusage statusline` is already wired to read
   Claude Code's hook stdin. Syntaur can wrap it (statusline composition) or
   call ccusage from its own statusline.
6. **Active maintenance**, Rust + TypeScript implementation, installable via
   `bunx`, `npm`, `pnpm`, `nix`.

### The one gap, and how to close it

ccusage **does not expose project / cwd attribution**, but the raw data is
already in the file paths it parses:

- **Claude Code** stores sessions under
  `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. The directory name *is*
  the working directory (e.g. `-Users-brennen-syntaur`).
- **Codex** session JSONL events carry `turn_context` which includes `cwd`.

So Syntaur's collector becomes a two-step:

1. Shell out to `ccusage session --json --since <last_run>` for token/cost
   rollups, by session id.
2. Read the same JSONL files directly *just* to extract `cwd` (and timestamp
   range) per session id.
3. Join `(cwd, timestamp range)` against `.syntaur/context.json` history to
   resolve which assignment was active when those tokens were spent.

### Cost / pricing

Everyone in this ecosystem uses LiteLLM's published `model_prices.json`.
ccusage embeds it in Nix builds and fetches it for standard builds; supports
`--offline` with pre-cached pricing. Syntaur should rely on ccusage's pricing
output and not maintain its own price table.

## toktrack — one pattern worth stealing

**Repo:** https://github.com/mag123c/toktrack
**License:** MIT

Scope is smaller than ccusage (Claude Code, Codex CLI, Gemini CLI, OpenCode
only). Built in Rust. Worth studying for one pattern:

> **Immutable per-day summaries** at `~/.toktrack/cache/`. Once a day is
> summarized, the cached result is never modified — only the current day is
> recomputed on each run.

This matters because Claude and Codex **rotate and delete** session JSONL
files over time. If Syntaur recomputes from raw logs every run (like ccusage
does), it will silently lose history. Persist our own per-day ledger.

**Apply the pattern as a SQLite table, not JSON files.** Syntaur already runs
better-sqlite3 with a versioned schema and a `sessions` table at the exact
join grain we need (`session_id → project_slug, assignment_slug, started,
ended`). The right shape is a new `usage_daily` table keyed by
`(date, tool, model, project_slug, assignment_slug)` with the same immutability
rule: rows for closed days are frozen, today's row is recomputed on each
collector run. Raw events go in a sibling `usage_events` table (FK to
`sessions.session_id`). Both live in a new `src/db/usage-db.ts` module
alongside `leases-db.ts` and `proof-db.ts`. See the project's `decision-record.md`
for the full rationale.

## TokenTracker — worth reading the source, not depending on

**Repo:** https://github.com/mm7894215/TokenTracker
**License:** MIT

Has the feature Syntaur wants — per-project attribution and a hook-based
detection model. Three detection strategies:

1. **Hook-based** (Claude Code, Codex CLI) — installs a `SessionEnd` hook
   into `~/.claude/settings.json` that notifies the tracker.
2. **Plugin-based** (OpenCode, OpenClaw) — ships plugins in the npm package.
3. **Passive readers** (Cursor, Kiro) — polls SQLite / JSONL files those
   tools already produce.

Stores in local SQLite, aggregates into 30-minute UTC buckets. Web dashboard
at `localhost:7680`, macOS menu bar app, four desktop widgets.

**Why not depend on it:** SQLite schema is undocumented, daemon API is
undocumented, no JSON output flag documented. To use it programmatically
Syntaur would have to reverse-engineer the schema and risk breakage on every
release. **But the hook installer pattern is worth lifting** — Syntaur should
install its own `SessionEnd` hook into Claude Code (likely already does via
the protocol) and have it stamp the active assignment id onto a usage event.

## Claude-Code-Usage-Monitor — UX inspiration, no integration value

**Repo:** https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
**License:** MIT

Real-time terminal monitor with P90 percentile predictions over an 8-day
window. Python (Rich, Pydantic, numpy). Watches `~/.config/claude`. **TUI
only — no JSON, no API, no library.** Cannot integrate against.

Worth borrowing the prediction model conceptually if Syntaur ever wants
"this assignment will likely exhaust your 5-hour window in 47 minutes at the
current burn rate" warnings. Otherwise, skip.

## ccflare — reference for the dashboard layer

A community web dashboard that reuses ccusage's JSONL-parsing approach but
renders as a browser UI. Reference for **what** charts and tables to put in
the Syntaur dashboard's usage view. Not a dependency.

## CodexBar / SessionWatcher — menu-bar inspiration

Always-on menu-bar surfaces for Codex (and Claude / Copilot / Cursor / Gemini
for SessionWatcher). Useful UX reference for a lightweight, ambient "you've
spent $X today across N agents" surface.

## Architectural conclusion

```
Syntaur usage collector (proposed):

  ┌──────────────────────────────────────────────────────────────┐
  │  cron / SessionEnd hook / dashboard-on-demand                │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
   ┌────────────────────────────────────────────────────────────┐
   │  1. shell: `ccusage session --json --since <last_run>`     │
   │     → token + cost rollups keyed by session id             │
   │                                                            │
   │  2. direct read of ~/.claude/projects/*/*.jsonl  &         │
   │     $CODEX_HOME/sessions/*.jsonl                           │
   │     → extract cwd, start_ts, end_ts per session            │
   │                                                            │
   │  3. join (cwd, time-range) against the `sessions` table    │
   │     in ~/.syntaur/sessions.db → resolve assignment /       │
   │     project for each session_id                            │
   │                                                            │
   │  4. persist via new `src/db/usage-db.ts`:                  │
   │     - `usage_events` (raw, FK to sessions.session_id),     │
   │       idempotent on (session_id, event_seq)                │
   │     - `usage_daily` (immutable rollup; closed days frozen, │
   │       today recomputed each run — toktrack pattern as a    │
   │       table, not a JSON file)                              │
   │                                                            │
   │  5. expose to dashboard via SQL joins on sessions:         │
   │     - per-assignment cost / token totals                   │
   │     - per-project rollups                                  │
   │     - per-tool breakdown                                   │
   │     - 5-hour-window live burn (ccusage blocks --json)      │
   └────────────────────────────────────────────────────────────┘
```

Effort estimate: ~1–2 days for a working v1 of the collector + a basic
dashboard view. The hard work — 14 CLI parsers, pricing data, log-format
quirks — is borrowed from ccusage under MIT.

## Open questions for follow-on work

1. **Distribution.** Bundle ccusage as a Syntaur dependency (npm peer dep?
   vendored binary?) or require users to install it separately?
2. **Real-time vs batch.** Run the collector on a `SessionEnd` hook (live
   updates, requires hook install) or on a cron / dashboard-load basis
   (simpler, lags behind by minutes)?
3. **Team rollups.** Single-machine local-only, or sync the `usage_daily`
   rows to a Syntaur cloud / shared store for team aggregation?
4. **Budget enforcement.** Tracking is plentiful in the ecosystem; *blocking*
   an assignment that exceeds a budget isn't. Worth exploring as a
   differentiator?
5. **Statusline integration.** Augment Syntaur's existing statusLine
   (`syntaur configure-statusline`) with a `usage` segment that calls
   `ccusage statusline` and adds assignment context?

## Sources

### Recommended dependency
- ccusage repo: https://github.com/ryoppippi/ccusage
- ccusage docs: https://ccusage.com/
  - JSON output: https://ccusage.com/guide/json-output
  - Codex guide: https://ccusage.com/guide/codex/
  - Statusline guide: https://ccusage.com/guide/statusline

### Reference / pattern lifting
- toktrack: https://github.com/mag123c/toktrack
- TokenTracker: https://github.com/mm7894215/TokenTracker
- Claude-Code-Usage-Monitor: https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
- ccflare overview: https://claudefa.st/blog/tools/monitors/claude-code-usage-monitor
- ccusage-web (DEV): https://dev.to/hamzaahmedkhan/ccusage-web-web-dashboard-to-track-claude-code-token-costs-3l17

### Menu-bar references
- CodexBar: https://github.com/steipete/CodexBar
- Claude-Code-Usage-Tracker (Tauri): https://github.com/LyndonWangWork/Claude-Code-Usage-Tracker
- claude-usage (phuryn): https://github.com/phuryn/claude-usage

### Pricing data
- LiteLLM spend tracking: https://docs.litellm.ai/docs/proxy/cost_tracking

### Background reading
- TIL: tracking your Codex tokens usage (Aman Mittal):
  https://amanhimself.dev/blog/codex-tokens-usage/
- "10 GitHub Repos That Cut Claude Code Token Usage by 60–90%":
  https://medium.com/coding-nexus/10-github-repos-that-cut-claude-code-token-usage-by-60-90-b0105cec4081
- "6 free GitHub repos that cut your Claude Code token bill":
  https://www.deployhq.com/blog/free-github-repos-for-claude-code

### Excluded
- tokscale (https://github.com/junhoyeo/tokscale) — excluded per user
  instruction after the project's hosted page returned a prompt-injection
  payload during research. Technically interesting (Rust core, opt-in
  leaderboard, well-documented per-tool source paths) but not eligible.
