# Audit Timeline: per-assignment event log of all changes

**Date:** 2026-06-16
**Complexity:** medium
**Tech Stack:** TS ESM (Node>=20), commander CLI, Express 5 API, React SPA (`dashboard/`), better-sqlite3 (WAL) on `~/.syntaur/syntaur.db`, ws, vitest, tsup

## Objective
Add an append-only `events` table to `~/.syntaur/syntaur.db` recording a **defined set of tracked assignment mutations** (the v1 event types below) through one central `recordEvent()`, plus a `syntaur timeline` CLI, an idempotent backfill from `statusHistory`+`planApproval`, and a dashboard "Activity" tab. Gives a single chronological "who changed what, when, from→to" trail per assignment.

**v1 tracked event types (the contract — see "Mutation Inventory & Scope"):** `status-change`, `assignee-change`, `priority-change`, `archived`, `restored`, `plan-approval`, `fact-set`, `attestation`, `comment-added`, `comment-resolved`. (`fact-clear` is DEFERRED — no `fact clear` verb exists in v1; see the deferred inventory row.) Every mutation that changes one of these emits through `recordEvent()`; the codebase's other ~15 assignment-writing paths (title, todos, acceptance-criteria checkboxes, workspace/worktree fields, plan-file create/version, todo promotion, workspace-group move) are **explicitly out of scope for v1** and enumerated in the Excluded table. The dashboard generic raw-edit/create routes do NOT get per-field routes — they emit by **diffing the tracked frontmatter fields** (status / priority / assignee / archived) before vs after the write.

## Verified design decisions (do not re-derive)
- **Status chokepoint is NOT `appendStatusHistoryEntry`.** That function (`src/lifecycle/frontmatter.ts:760`, signature `appendStatusHistoryEntry(fileContent: string, entry: StatusHistoryEntry): string`) is a pure string transform with no `assignment_id`/`project_slug`/file path/actor context. Hooking `recordEvent()` inside it is wrong (no IDs, would force a DB write into a string util, and would also fire during migrations). **Strategy:** introduce a tiny shared wrapper `recordStatusEvent(...)` in a new `src/lifecycle/event-emit.ts` and call it at each of the verified status-write sites immediately after the existing `appendStatusHistoryEntry(...)` call, guarded by `targetStatus !== frontmatter.status`. A module-level `suppressEvents` guard (set by migrations) makes those emits no-ops.
- **Verified status-write sites** (each calls `appendStatusHistoryEntry`): `src/lifecycle/transitions.ts:171` (executeTransition), `:299` (executeTransitionByDir); `src/lifecycle/recompute.ts:259` (same-status fact/attestation audit entry — `from === to`), `:283` (dimension change — `from !== to`); `src/utils/status-config-resolution.ts:244`; `src/dashboard/api-write.ts:963` (project create raw), `:1085` (project raw edit), `:2326` (standalone create raw), `:2592` (standalone raw edit). The four dashboard status-write sites — `963, 1085, 2326, 2592` — are all CONFIRMED real `appendStatusHistoryEntry` call sites (the scout's earlier "unconfirmed" note on `2326`/`2592` was wrong); still run a final `grep -n 'appendStatusHistoryEntry(' src/dashboard/api-write.ts` during Task B to catch any beyond these. MIGRATION sites (suppress): `src/commands/migrate-statuses.ts:143`, `src/commands/migrate-status-history.ts:155`.
- **Same-status guard (R5):** `recompute.ts:259` appends a statusHistory entry even when status is UNCHANGED (the fact/attestation audit entry has `from === frontmatter.status === to`). `recordStatusEvent` MUST emit a `status-change` event ONLY when `from !== to`; same-status derive entries produce NO `status-change` event (the underlying `fact-set`/`attestation` event already covers that mutation). This `from !== to` guard is required at ALL status emit sites (transitions + recompute `:283` + status-config-resolution + the four dashboard raw sites, which already test `next.status !== current.status`).
- **Actor resolution (R7 — reuse existing per-site logic):** each emit site already computes its own actor/`by` — do NOT centralize or re-derive it. CLI status sites use `options.agent ?? frontmatter.assignee ?? null` (transitions.ts:176, :304); derive/fact/attestation/plan-approval sites use `derive-verbs.ts:78` `inferActor()` (returns `agent:<name>` from `--agent`, else `agent:<sessionId[:8]>` from the bound `.syntaur/context.json`, else `'human'`); the dashboard hardcodes `'human'` (api-write.ts:1909, 2161, 2209, +others). `recordEvent()`/`recordStatusEvent()` take the already-resolved `actor` string verbatim; the only mapping is `resolveActor(by: string | null) → by ?? 'system'` (null → `'system'`, used by recompute). Reuse `inferActor()` for fact/attestation/plan-approval events rather than re-implementing actor inference.
- **DB module:** mirror `src/db/proof-db.ts` exactly (exports `initProofDb`/`getProofDb`/`closeProofDb`/`resetProofDb` + list; WAL; `meta` row; exclusive empty-migration tx). Multi-version upgrade scaffold per `src/dashboard/session-db.ts:72-241`. All modules share one `resolve(syntaurRoot(),'syntaur.db')`; events owns the `events_schema_version` meta row.
- **`recordEvent()` is the ONLY writer (R3):** `insertEvent` is **private** (module-local, NOT exported) to `events-db.ts`. The only exported write path is `recordEvent(...)` (best-effort try/catch, never throws). The `recordStatusEvent()` wrapper and the backfill BOTH go through `recordEvent` — nothing outside `events-db.ts` ever calls `insertEvent` directly. The backfill uses a `recordEvent({ ... , at, actor, sourceKey })` form that lets the caller supply the historical `at`/`actor` and a deterministic `sourceKey` (live emits omit `sourceKey`).
- **Idempotency via `source_key` (R4):** the `events` table has a nullable `source_key TEXT UNIQUE` column. Live events: `source_key` is NULL (null is exempt from UNIQUE in SQLite, so every live event always inserts). Backfilled events: a DETERMINISTIC key — `backfill:<assignmentId>:status:<index>` (per `statusHistory` entry, `<index>` = its position) and `backfill:<assignmentId>:plan-approval`. `recordEvent` inserts with `INSERT OR IGNORE` keyed on `source_key`, so re-running the backfill inserts 0 rows. This is idempotent PER EVENT (not per assignment), survives partial failures, and is concurrency-safe — it REPLACES the coarse `hasEventsForAssignment` skip as the idempotency mechanism. Each assignment's backfill runs inside a single SQLite transaction. `hasEventsForAssignment` is retained ONLY for the dry-run preview count; it MUST NOT gate inserts.
- **Live update:** reuse the existing `assignment-updated` WS broadcast (`src/dashboard/server.ts:148`, fired by the file watcher; SPA refetches via `useWebSocket` → `useAssignment().refetch()`). No new WS message type.
- **Backfill:** mirror `src/commands/migrate-status-history.ts` (collectTargets scan over `projectsBase` + `getStandaloneDir()` lines 56-109; dry-run default; `--apply`). One event per `statusHistory` entry (`sourceKey = backfill:<id>:status:<index>`) + one `plan-approval` event per assignment with `planApproval` frontmatter (`sourceKey = backfill:<id>:plan-approval`, `at = planApproval.at ?? updated`). Every backfill insert goes through `recordEvent` with its `sourceKey`; idempotency is per-event via `INSERT OR IGNORE` on `source_key` (R4) — NOT a per-assignment skip. Each assignment's events are written in one SQLite transaction.
- **Best-effort:** `recordEvent()` and `recordStatusEvent()` wrap everything in try/catch, log `console.warn`, never throw into the mutation path.

## Mutation Inventory & Scope

This inventory is the contract that makes "no **tracked** mutation bypasses the log" verifiable: every v1 event type maps to an explicit emit site, and every out-of-scope assignment-writing path is named with a reason. Run a final grep per type during implementation, but these tables are the source of truth for scope.

### Included (v1) — tracked event type → emit site(s)

| Event type | Emit site(s) (file:line) | Actor source | Notes |
|---|---|---|---|
| `status-change` | CLI: `transitions.ts:171` (executeTransition), `:299` (executeTransitionByDir); `recompute.ts:283` (dimension change); `status-config-resolution.ts:244` (remap). Dashboard: `api-write.ts:963, 1085, 2326, 2592` (raw create/edit, both project + standalone). | CLI `options.agent ?? frontmatter.assignee ?? null`; recompute `'system'`; dashboard `'human'` | Emit ONLY when `from !== to` (R5). Dashboard sites are the **raw-edit diff** path (R1) — they already test `next.status !== current.status`. |
| `assignee-change` | CLI: `transitions.ts` `executeAssign` (~:196) + the `*ByDir` assign path. Dashboard: assignee PATCH (~api-write.ts:1909). | CLI per-site; dashboard `'human'` | |
| `priority-change` | Dashboard **raw-edit frontmatter diff** only — `next.priority !== current.priority` at `api-write.ts:1037`/`:2545` (both parse `current`+`next` via `parseAssignmentFull`). **No CLI priority verb exists** (verified). Initial priority at create is not a change. | `'human'` | No CLI priority verb; no dedicated dashboard priority route. |
| `archived` | CLI: `archive.ts` / `_archive-helper.ts`. Dashboard: archive route. | CLI per-site; dashboard `'human'` | Dashboard generic raw-edit diff of `archived` also emits. |
| `restored` | CLI: `restore.ts` / `_archive-helper.ts`. Dashboard: restore route. | CLI per-site; dashboard `'human'` | |
| `plan-approval` | CLI ONLY: `derive-verbs.ts:149` (`planApproveCommand`, registered at `plan.ts:478` as `plan approve`). | `derive-verbs.ts:78` `inferActor()` | There is NO dashboard plan-approval route (R6) — do not look for one in api-write.ts. |
| `fact-set` | CLI: `derive-verbs.ts` fact verbs (via `assertFact`). | `derive-verbs.ts:78` `inferActor()` | |
| `fact-clear` | **DEFERRED** — no `fact clear` verb exists in v1 (no CLI verb, no emit site); dropped from the tracked-types contract. | n/a (deferred) | Re-add when a `fact clear` verb ships. |
| `attestation` | CLI: `derive-verbs.ts` (~:273, after `upsertAttestation`). | `derive-verbs.ts:78` `inferActor()` | |
| `comment-added` | CLI: `comment.ts` (~:69). Dashboard: comments POST. | CLI per-site; dashboard `'human'` | Details = author + excerpt/length only; NO body/transcript content. |
| `comment-resolved` | CLI/dashboard comment-resolve paths (`api-write.ts:1431`/`:3214`). | CLI per-site; dashboard `'human'` | |

### Excluded (v1, documented) — out-of-scope assignment-writing paths

| Path | Where | Reason excluded from v1 |
|---|---|---|
| Title change | `api-write.ts:2089`/`:2870`; CLI title edit | Not a tracked lifecycle event type; cosmetic rename. |
| Acceptance-criteria checkbox toggle | `api-write.ts:1104`/`:2904` | High-frequency, non-lifecycle; out of v1 scope. |
| Todos (add/check/promote) | plan/todo write paths; todo promotion | Todo churn is not a lifecycle audit event in v1. |
| Workspace / worktree fields | `set-workspace`, worktree/workspace cmds | Tooling metadata, not a mutation of assignment state. |
| Workspace-group move | `api-write.ts:1478` | Board organization, not assignment lifecycle. |
| Plan-file create / version | `plan.ts` create/version (distinct from `plan approve`) | The plan FILE write is excluded; only `plan-approval` (the derived fact) is tracked. |
| Request / todo promotion | request/todo promotion paths | Promotion plumbing; the resulting assignment's own events are tracked. |
| Status RENAME (config edit) | `status.ts:490` | Renames a status label config-wide, not a per-assignment transition. |
| Raw frontmatter edits to untracked fields | `api-write.ts:1037`/`:2545` (generic raw edit) | The raw-edit route is instrumented ONLY for the tracked-field diff (status/priority/assignee/archived); changes to any other field emit nothing. |

Instrumenting all ~15 assignment-writing paths is explicitly out of scope; v1 covers the Included table above and nothing else.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `src/db/events-db.ts` | CREATE | events table (incl. `source_key TEXT UNIQUE`), schema/migration, `recordEvent` (ONLY exported writer; `insertEvent` private), `listEvents*` (mirrors proof-db.ts) |
| `src/lifecycle/event-emit.ts` | CREATE | `recordStatusEvent()` wrapper, `actor` resolver, `suppressEvents` guard |
| `src/lifecycle/transitions.ts` | MODIFY | emit status events at :171, :299; assignee/unassign emits |
| `src/lifecycle/recompute.ts` | MODIFY | emit status event at :283 (actor `'system'`); :259 is same-status (`from === to`) → NO `status-change` event (R5) |
| `src/utils/status-config-resolution.ts` | MODIFY | emit status event at :244 (remap) |
| `src/commands/derive-verbs.ts` | MODIFY | emit fact set/clear + attestation events |
| `src/commands/comment.ts` | MODIFY | emit `comment` event (~:69) |
| `src/commands/archive.ts`, `restore.ts`, `_archive-helper.ts` | MODIFY | emit `archive`/`restore` events |
| `src/commands/migrate-statuses.ts`, `migrate-status-history.ts` | MODIFY | wrap writes in `suppressEvents` |
| `src/dashboard/api-write.ts` | MODIFY | emit events with `actor:'human'`: status via raw-create/edit diff (`963, 1085, 2326, 2592`), priority via raw-edit frontmatter diff (NO dedicated priority route), assignee PATCH, block/unblock, comment add/resolve, archive/restore. NO plan-approval route here (R6 — plan-approval is CLI-only). |
| `src/commands/timeline.ts` | CREATE | `syntaur timeline` CLI (mirror ls.ts/search.ts) |
| `src/commands/migrate-events.ts` | CREATE | idempotent backfill (mirror migrate-status-history.ts) |
| `src/index.ts` | MODIFY | register `timeline` + `migrate-events` (mirror :333-341) |
| `src/dashboard/api-events.ts` | CREATE | GET events route(s) |
| `src/dashboard/server.ts` | MODIFY | mount events router |
| `dashboard/src/components/ActivityTimeline.tsx` | CREATE | renders events newest-first |
| `dashboard/src/hooks/useAssignmentEvents.ts` | CREATE | fetch events per assignment |
| `dashboard/src/pages/AssignmentDetail.tsx` | MODIFY | add "Activity" tab to items array (~:618-833) |
| `dashboard/src/pages/StandaloneAssignmentDetail.tsx` | MODIFY | add "Activity" tab (~:158-294) |
| `docs/cli.md`, `README.md` | MODIFY | document `syntaur timeline` + `migrate-events` |

## Tasks

### A. events-db module + recordEvent + schema/migration + tests
- **File:** `src/db/events-db.ts` (CREATE)
- **What:** Copy `src/db/proof-db.ts` structure. `EVENTS_SCHEMA_VERSION='1'`. Table `events`: `event_id TEXT PRIMARY KEY`, `assignment_id TEXT NOT NULL`, `project_slug TEXT` (nullable for standalone), `at TEXT NOT NULL` (UTC ISO 8601, lexicographically sortable), `actor TEXT NOT NULL`, `type TEXT NOT NULL`, `details TEXT` (JSON), `source_key TEXT UNIQUE` (nullable — R4). Index `idx_events_assignment_at ON events(assignment_id, at)` and `idx_events_at ON events(at)`. Generate `event_id` via `crypto.randomUUID()`.
- **`recordEvent` is the ONLY exported writer (R3):** `insertEvent(row)` is **module-private** — declared but NOT exported. `recordEvent(input)` is the single exported write path: best-effort `try { initEventsDb(); insertEvent({ event_id: randomUUID(), source_key: input.sourceKey ?? null, ... }) } catch (e) { console.warn(...) }`, never throws. The INSERT uses `INSERT OR IGNORE INTO events (...)` so a duplicate non-null `source_key` is silently skipped (null keys always insert — SQLite UNIQUE exempts NULL). `recordEvent` accepts an optional `at`/`actor`/`sourceKey` (backfill supplies historical values; live emits omit `sourceKey` and let `at` default to now). Nothing outside this module calls `insertEvent`.
- **Exports:** `initEventsDb(dbPath?)`, `getEventsDb()`, `closeEventsDb()`, `resetEventsDb()`, `recordEvent(input)`, `listEventsByAssignment(assignmentId, filters?)`, `hasEventsForAssignment(assignmentId): boolean` (dry-run preview count only — NOT an idempotency gate; R4). `meta` row key `events_schema_version`; exclusive empty-migration tx as the v2+ scaffold (copy session-db.ts:72-241 comment shape).
- **Pattern:** `src/db/proof-db.ts` (exact), migration scaffold `src/dashboard/session-db.ts:72-241`.
- **File:** `src/__tests__/events-db.test.ts` (CREATE) — mirror `src/__tests__/proof-db.test.ts`: `mkdtemp` temp path → `initEventsDb(testDbPath)`, assert schema (incl. `source_key UNIQUE`) + `events_schema_version` meta row, `recordEvent`/list round-trip, index existence, AND `INSERT OR IGNORE` idempotency (two `recordEvent` calls with the same non-null `sourceKey` → exactly 1 row; two with `sourceKey: null` → 2 rows); `closeEventsDb()`+`resetEventsDb()` in `afterEach`.
- **Verify:** `npm run typecheck && npx vitest run src/__tests__/events-db.test.ts`

### B. instrument status chokepoint + migration suppression
- **File:** `src/lifecycle/event-emit.ts` (CREATE)
- **What:** Module-level `let suppressEvents = false` with `setSuppressEvents(v)` / `withSuppressedEvents(fn)`. `resolveActor(by: string | null): string` → `by ?? 'system'` (the ONLY actor mapping — sites pass their own resolved `by`, R7). `recordStatusEvent({ assignmentId, projectSlug, at, actor, from, to, command })`: **if `from === to` return immediately (R5 — no `status-change` event for same-status writes)**; if `suppressEvents` return; else delegate to `recordEvent({ type:'status-change', details: JSON.stringify({from,to,command}), ... })` (R3 — never calls the private `insertEvent` directly). `recordEvent` already wraps best-effort try/catch and never throws.
- **What (call sites — `from !== to` guard mandatory at ALL of them, R5):** After each verified `appendStatusHistoryEntry(...)`, add `recordStatusEvent(...)` passing each site's OWN resolved actor (R7):
  - `transitions.ts:171`, `:299` — actor `resolveActor(options.agent ?? frontmatter.assignee ?? null)`.
  - `recompute.ts:283` (dimension change, `from !== to`) — actor `'system'`. **`recompute.ts:259` is the same-status fact/attestation audit entry (`from === to`) → `recordStatusEvent` self-guards and emits NO event; the `fact-set`/`attestation` event from Task C covers that mutation.**
  - `status-config-resolution.ts:244` — actor `'system'` (or the site's existing `by` if present).
  - The four dashboard status sites (`api-write.ts:963, 1085, 2326, 2592`) are handled in Task C with `actor:'human'`; they already test `next.status !== current.status`, satisfying the `from !== to` guard.
  `assignment_id` = frontmatter `id`; `project_slug` from the resolved path/config (null for standalone). Run `grep -n 'appendStatusHistoryEntry(' src/dashboard/api-write.ts` to confirm the four sites and catch any new one.
- **What (suppression):** In `migrate-statuses.ts` and `migrate-status-history.ts`, wrap the apply loop in `withSuppressedEvents(...)` (or `setSuppressEvents(true)`/`finally false`) so seeded statusHistory writes do NOT emit live events.
- **Pattern:** best-effort isolation lives in `recordEvent` (proof-db pattern); actor reuse mirrors transitions.ts:176 and `derive-verbs.ts:78`.
- **Verify:** `npm run typecheck && npx vitest run src/__tests__/lifecycle-commands.test.ts` (assert: a CLI transition with `from !== to` writes exactly one `status-change`; a same-status derive/fact write writes ZERO `status-change` (R5); a migrate apply writes zero).

### C. instrument non-status mutations (CLI + dashboard)
- **All emits go through `recordEvent(...)` (R3)** — never the private `insertEvent`. **Each site passes its OWN already-resolved actor (R7)** — do not re-derive.
- **File:** `src/commands/derive-verbs.ts` (MODIFY) — emit `fact-set` (details: name, value/old→new; `fact-clear` deferred — no `fact clear` verb) and `attestation` (after `upsertAttestation` ~`frontmatter.ts:728`, called ~`derive-verbs.ts:273`), AND the `plan-approval` event in `planApproveCommand` (`:149`, registered as `plan approve` at `plan.ts:478`). **Actor for all of these = `inferActor(options)` (`derive-verbs.ts:78` — `agent:<name>` / `agent:<sessionId>` / `human`); reuse it, don't re-implement (R7).**
- **File:** `src/commands/comment.ts` (MODIFY ~:69) — emit `comment-added` (details: author, excerpt/length only; NO transcript/body content per AC "no new sensitive data"); emit `comment-resolved` on the resolve path.
- **File:** `src/lifecycle/transitions.ts` (MODIFY) — emit `assignee-change` in `executeAssign` (:196) and the `*ByDir` assign/unassign paths (actor = the site's existing `options.agent ?? frontmatter.assignee ?? null`).
- **File:** `src/commands/archive.ts` / `restore.ts` / `_archive-helper.ts` (MODIFY) — emit `archived`/`restored` (details: reason), actor from the site's existing computation.
- **File:** `src/dashboard/api-write.ts` (MODIFY) — emit with `actor:'human'`:
  - `status-change` via the raw create/edit DIFF (`from !== to`) at `:963, 1085, 2326, 2592` (the four confirmed `appendStatusHistoryEntry` sites — R2).
  - `priority-change` via the raw-edit frontmatter DIFF (before-vs-after `priority`) on the generic raw-edit route — there is **NO dedicated dashboard priority route** (R6).
  - `assignee-change` (assignee PATCH ~:1909, diff `assignee`), `archived`/`restored` (diff `archived` on raw-edit + the archive/restore routes), block/unblock (~:2161), `comment-added`/`comment-resolved` (comments POST + resolve `:1431`/`:3214`).
  - **NO `plan-approval` emit here** — there is no dashboard plan-approval route; `plan-approval` is CLI-only (R6).
  Never throw into a route (recordEvent is best-effort).
- **What:** Each emit: `type` from the Included inventory table, `details` = JSON of `{ from, to }` or `{ name, value }` etc. — field names/values already in the assignment only.
- **Pattern:** dashboard actor `'human'` per api-write.ts:1909; CLI status/assignee actor via `options.agent ?? frontmatter.assignee ?? null`; fact/attestation/plan-approval actor via `inferActor()` (derive-verbs.ts:78).
- **Verify:** `npm run typecheck && npx vitest run src/__tests__/dashboard-api-usage.test.ts`

### D. `syntaur timeline` CLI + registration + tests
- **File:** `src/commands/timeline.ts` (CREATE)
- **What:** `timeline <assignment> [--project <slug>] [--json] [--since <date>] [--type <list>] [--limit <n>]`. Resolve assignment dir via the `ls.ts`/`_lifecycle-helper.ts` resolution + `--project`/`readConfig`; read the assignment's `id`; `initEventsDb()` then `listEventsByAssignment(id, {since, types, limit})` ordered by `at DESC` (newest-first). Human output = table (at, actor, type, from→to); `--json` = structured array. `--type` is comma-split list; `--since` filters `at >= since`.
- **File:** `src/index.ts` (MODIFY) — register the command mirroring the `migrate-status-history` block (:333-341) + add the import near :15.
- **File:** `src/__tests__/timeline.test.ts` (CREATE) — temp dir + temp db; seed events; assert ordering, `--json` shape, and `--since`/`--type`/`--limit` filters.
- **Pattern:** `src/commands/ls.ts` / `search.ts` (--json + resolution), registration `src/index.ts:333-341`.
- **Verify:** `npm run build && node dist/index.js timeline --help && npx vitest run src/__tests__/timeline.test.ts`

### E. events backfill `migrate-events` + registration + tests
- **File:** `src/commands/migrate-events.ts` (CREATE)
- **What:** Mirror `migrate-status-history.ts`. `collectTargets` scans `[projectsBase, getStandaloneDir()]` (project + standalone shapes, lines 56-109 pattern). For each assignment synthesize (NO per-assignment skip — R4): one event per `statusHistory` entry (type `status-change`, `at`=entry.at, actor=`entry.by ?? 'system'`, details from/to/command, **`sourceKey = backfill:<id>:status:<index>`** where `<index>` is the entry's position in the array), plus one `plan-approval` event if `planApproval` frontmatter present (`at = planApproval.at ?? frontmatter.updated`, **`sourceKey = backfill:<id>:plan-approval`**). **Each event is written via `recordEvent({ ..., at, actor, sourceKey })` (R3 — never `insertEvent` directly).** Wrap each assignment's events in a single SQLite transaction. Idempotency is per-event via `INSERT OR IGNORE` on `source_key` — re-running `--apply` inserts 0, survives partial failures, is concurrency-safe (R4). Dry-run default prints a per-assignment diff (count of events that WOULD insert — may use `hasEventsForAssignment`/a count for preview only; it does NOT gate the real insert).
- **File:** `src/index.ts` (MODIFY) — register `migrate-events` mirroring :333-341.
- **File:** `src/__tests__/migrate-events.test.ts` (CREATE) — mirror `migrate-status-history.test.ts`: temp dir as `--dir`, temp db; assert dry-run writes nothing; `--apply` inserts N events; re-running `--apply` inserts 0 (idempotent **via `source_key`**); a SECOND assignment added after a first apply backfills only its own new events on re-apply (per-event, not per-assignment, idempotency — R4); `planApproval` produces exactly one `plan-approval` event with `source_key = backfill:<id>:plan-approval`.
- **Pattern:** `src/commands/migrate-status-history.ts` (collectTargets, dry-run/apply), test mirror `src/__tests__/migrate-status-history.test.ts`.
- **Verify:** `npm run build && npx vitest run src/__tests__/migrate-events.test.ts`

### F. dashboard: GET events route + Activity tab + live update
- **File:** `src/dashboard/api-events.ts` (CREATE) — Express router: `GET /api/projects/:slug/assignments/:aslug/events` and the standalone equivalent (`GET /api/standalone/assignments/:id/events`). Resolve assignment `id`, `initEventsDb()`, `listEventsByAssignment(id)` newest-first, return JSON. Best-effort: on DB error return `[]` (never 500 the detail page).
- **File:** `src/dashboard/server.ts` (MODIFY) — mount the events router alongside existing API routers.
- **File:** `dashboard/src/hooks/useAssignmentEvents.ts` (CREATE) — fetch the events endpoint; expose `{ data, loading, error, refetch }`. Mirror an existing tab-data hook.
- **File:** `dashboard/src/components/ActivityTimeline.tsx` (CREATE) — render events newest-first (actor, type, from→to, relative time), empty-state when none.
- **File:** `dashboard/src/pages/AssignmentDetail.tsx` (MODIFY ~:618-833) — add `{ value:'activity', label:'Activity', count: events?.length, content: <ActivityTimeline events={...}/> }` to the `items` array; wire `useAssignmentEvents` + call its `refetch()` from the existing `assignment-updated` WS handler that already drives `useAssignment().refetch()` (~:73). Tab shape = `{ value, label, count?, content }` per `dashboard/src/components/ContentTabs.tsx`.
- **File:** `dashboard/src/pages/StandaloneAssignmentDetail.tsx` (MODIFY ~:158-294) — same Activity tab against the standalone events endpoint.
- **Pattern:** existing tabs (summary/plan/progress at the cited lines), WS reuse `server.ts:148` + `dashboard/src/hooks/useWebSocket.ts`.
- **Verify:** `npm run typecheck && npm run build --prefix dashboard` (root typecheck EXCLUDES `dashboard/`, so the SPA build is the real TS gate).

### G. docs
- **File:** `docs/cli.md` (MODIFY) — add `syntaur timeline` (flags) and `syntaur migrate-events` (dry-run/--apply) sections.
- **File:** `README.md` (MODIFY) — one line on the audit timeline + Activity tab.
- **Verify:** `node dist/index.js timeline --help` output matches the documented flags.

### H. full verification gate
- **What:** Run the complete suite after all tasks.
- **Verify:**
  - `npm run typecheck`
  - `npm test` (or `npx vitest run`)
  - `npm run build --prefix dashboard`
  - `node dist/index.js timeline --help` and `node dist/index.js migrate-events --help`
  - Manual: `node dist/index.js migrate-events` (dry-run) then `--apply`, re-run `--apply` (expect 0 new), then `node dist/index.js timeline <assignment> --json`.

## Dependencies
- No new npm packages (`better-sqlite3`, `crypto.randomUUID`, `ws` already present).
- Fresh worktree setup before tests: root `npm install` + `npm install --prefix dashboard` + `npm run build`.
- No new env vars or GCP secrets.

## Verification
```
npm run typecheck
npm test
npm run build --prefix dashboard
node dist/index.js timeline --help
node dist/index.js migrate-events --help
```

## Risks
- **Scope is a DEFINED set, not "every mutation" (R1):** v1 tracks ONLY the 11 event types in the Mutation Inventory's Included table; the ~15 other assignment-writing paths are in the Excluded table with reasons. "No mutation bypasses the log" means no **tracked** mutation bypasses it — verified against the inventory, not against all writers. Dashboard generic raw-edit/create routes emit by diffing tracked frontmatter fields (status/priority/assignee/archived), not via per-field routes.
- **Chokepoint assumption (resolved):** `appendStatusHistoryEntry` is a pure string transform with no IDs/actor — do NOT emit inside it. Emit via `recordStatusEvent` at `transitions.ts:171,:299`, `recompute.ts:283`, `status-config-resolution.ts:244`, and the four CONFIRMED dashboard sites `api-write.ts:963, 1085, 2326, 2592` (R2 — `2326`/`2592` ARE real, the scout's "unconfirmed" note was wrong). Re-grep `appendStatusHistoryEntry(` in `api-write.ts` during Task B to catch any beyond these four.
- **Same-status event noise (R5):** `recompute.ts:259` appends a statusHistory entry with `from === to` (the fact/attestation audit entry). `recordStatusEvent` self-guards on `from !== to`, so same-status writes emit NO `status-change` event — the `fact-set`/`attestation` event covers them. The guard applies at every status site (the dashboard sites already test `next.status !== current.status`).
- **`recordEvent` is the only writer (R3):** `insertEvent` is private to `events-db.ts`. Live emits, `recordStatusEvent`, and the backfill all go through `recordEvent`. No code path inserts directly.
- **Backfill idempotency is per-EVENT via `source_key` (R4):** the `events` table has `source_key TEXT UNIQUE` (null for live events, deterministic `backfill:<id>:status:<index>` / `backfill:<id>:plan-approval` for backfilled). `recordEvent` uses `INSERT OR IGNORE` on `source_key`, so re-running `--apply` inserts 0, partial failures resume cleanly, and concurrent writers can't double-insert. Each assignment's backfill is one transaction. `hasEventsForAssignment` is retained only for the dry-run preview — it does NOT gate inserts (the coarse per-assignment skip is replaced).
- **Migration double-emit:** `migrate-statuses` / `migrate-status-history` write statusHistory and would fire live status events. Guard with `suppressEvents`.
- **Best-effort isolation:** every emit wrapped in try/catch + `console.warn` inside `recordEvent`; never roll back or re-throw into the mutation/route. Tests must include a forced-failure path (e.g., point events DB at an unwritable path) asserting the mutation still succeeds.
- **Standalone vs nested:** `project_slug` is nullable. `collectTargets` and the events route must handle both the `baseDir/<uuid>/assignment.md` standalone shape and `baseDir/<project>/assignments/<slug>/assignment.md` nested shape (per migrate-status-history.ts:69-105).
- **Actor resolution reuses per-site logic (R7):** each emit site passes its OWN resolved actor — CLI status/assignee `options.agent ?? frontmatter.assignee ?? null`; fact/attestation/plan-approval `inferActor()` (derive-verbs.ts:78); dashboard `'human'`. The only shared mapping is `resolveActor(by) → by ?? 'system'` (null → system, used by recompute). No central re-derivation.
- **No dashboard plan-approval/priority route (R6):** `plan-approval` is emitted CLI-only at `derive-verbs.ts:149` (`plan approve`, `plan.ts:478`) — there is no api-write.ts plan-approval route. `priority-change` is the dashboard raw-edit frontmatter diff only — there is **no CLI priority verb** (verified) and no dedicated dashboard priority route.
- **DB-in-two-processes under WAL:** CLI and dashboard server both open `syntaur.db`. WAL allows concurrent readers + one writer; keep `recordEvent` a single short `INSERT OR IGNORE` and reuse the singleton per process. The `source_key` UNIQUE constraint (not a recheck) is what makes a concurrent dashboard write + mid-backfill safe.
