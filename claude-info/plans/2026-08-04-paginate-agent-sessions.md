# Paginate the Agent Sessions page

**Assignment:** `paginate-the-agent-sessions-page` (project `syntaur-meta`)
**Assignment spec:** `~/.syntaur/projects/syntaur-meta/assignments/paginate-the-agent-sessions-page/assignment.md`
**Repo:** `/Users/brennen/syntaur`
**Created:** 2026-08-04

---

## Problem

`/agent-sessions` renders every session in one pass. Measured 2026-08-03:

| Measurement | Value |
|---|---|
| Sessions returned by `GET /api/agent-sessions?includeUsageOnly=1` | 2,443 |
| Response payload | 2.9 MB JSON (~1.2 KB avg/session) |
| Server time to produce it, cold and warm | ~40 ms |

`AgentSessionsPage.tsx:311` maps `filteredSessions` straight to `<tr>`s — no windowing, no page
slice, no cap. It repeats: the same fetch re-runs on every websocket `agent-sessions-updated`
broadcast (`useProjects.ts:644-651`).

---

## What the request path actually does

Verified against the running database and sources, because the first draft of this plan asserted a
cheap indexed read and was wrong:

- **`sessions` has no index on `started`.** The only indexes are the `session_id` primary-key
  autoindex and `idx_sessions_status ON sessions(status)`. `listAllSessions`
  (`agent-sessions.ts:774-780`) runs `ORDER BY s.started DESC`, so it is a **full scan plus sort**
  that degrades as sessions accumulate.
- **The row build is a correlated subquery per session.** `SESSION_SELECT_WITH_BINDING`
  (`agent-sessions.ts:54-65`) LEFT JOINs `engagement` through a per-row `SELECT e2.id ...`
  subquery to pick the chosen engagement.
- **`listSessionUsage()` reads every `usage_events` row on every request** (`usage-db.ts:461-518`)
  — 2,562 rows today — aggregates them in JS, and **computes cost in JS** via `priceForModel` when
  `total_cost` is 0. This is why spend cannot simply be ordered in SQL; see Task 4.
- **`reconcileActiveSessions` is not a paging concern.** It is scoped to
  `WHERE s.status = 'active'` (`agent-sessions.ts:884-891`), so it touches a handful of rows
  regardless of table size. Leave it where it is.
- **Liveness enrichment runs over the full set.** `enrichSessions` is applied to every session
  before the response is built (`api-agent-sessions.ts:201`). Under paging it should run on the
  page only — a real saving that falls out of this work.

Row counts today: 2,443 in `sessions`, 2,562 in `usage_events`.

---

## Approach: server-side paging

The endpoint returns a bounded page; filtering, sorting, and paging happen server-side so they span
the whole set rather than one page.

An earlier draft proposed client-side paging — fetch all 2,443, render a slice — reasoning that the
dashboard is localhost so the payload is nearly free. That was rejected in review and the rejection
was correct: it fails two non-optional acceptance criteria (bounded initial payload; websocket
refresh without re-downloading the full set), and it cannot satisfy the Overview blast-radius
criterion at all, because slicing an array *after* the response is parsed does not stop the
download. "Localhost, so the wire is free" was an argument for doing less work, not an argument
that the criteria were wrong.

**Spend sorting is the one thing the server cannot express as a SQL `ORDER BY`,** because cost is
computed in JS. Task 4 handles it with an ordered-id-list path over the full filtered union.

---

## Tasks

### Task 1 — Shared sort contract

**New file:** `src/utils/session-sort.ts`, alongside `src/utils/session-select.ts` and for the same
reason — root vitest can reach it.

**There is no wildcard `@shared/*` mapping.** Every shared module is aliased explicitly, so a new
one is not reachable until it is registered in three places, or dashboard typecheck and Vite
resolution both fail:

1. `dashboard/vite.config.ts` — add `'@shared/session-sort': resolve(__dirname, '../src/utils/session-sort.ts')`
   alongside the existing entries (lines 14-36).
2. `dashboard/tsconfig.json` — add the matching `paths` entry, and add the file to `include`.
3. `vitest.config.ts` / `vitest.dashboard.config.ts` — both already alias bare `@shared` to
   `src/utils`, so tests resolve it without further work. Verify rather than assume.

Server-side files import it by relative NodeNext path (`../utils/session-sort.js`), not the SPA
alias.

`SessionSort` currently exists only as an **unexported, page-local** `type` at
`AgentSessionsPage.tsx:18-26`. The server route, the query layer, and the hook all need it, so it
must have a shared home before any of them can be typed:

```ts
export const SESSION_SORTS = [
  'started_desc', 'started_asc', 'duration_desc', 'duration_asc',
  'assignment_asc', 'agent_asc', 'spend_desc', 'tokens_desc',
] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];
export function isSessionSort(v: string): v is SessionSort
```

Import it in `AgentSessionsPage.tsx` (deleting the local type), the hook, the route, and the query.
`isSessionSort` is what the route uses to reject an unknown `sort` param rather than trusting input.

This task lands first because Tasks 2-5 reference the type in their signatures.

---

### Task 2 — Index `sessions(started)`

**File:** `src/dashboard/session-db.ts` (schema/migration block alongside `idx_sessions_status`)

Add `CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started);`.

Every default-sorted page (`started_desc`) depends on this; without it each page request still
scans and sorts the whole table, and paging buys nothing server-side. Follow the existing migration
idiom — do not hand-edit the live database. Confirm with `EXPLAIN QUERY PLAN` (Verification).

---

### Task 3 — Define the paged query contract

**Files:** `src/dashboard/api-agent-sessions.ts` (route at lines 194-208),
`dashboard/src/types.ts:188-191` (`AgentSessionsResponse`)

Accept on `GET /api/agent-sessions`:

| Param | Meaning |
|---|---|
| `pageSize` | positive int; **presence of this param opts into paging** |
| `page` | zero-based, default 0 |
| `search` | literal substring (see below) |
| `startedFrom` / `startedTo` | `YYYY-MM-DD`, inclusive — **plus a timezone offset**, see below |
| `workspace` | workspace name, or `_ungrouped` |
| `sort` | validated with `isSessionSort`; invalid ⇒ default |
| `includeUsageOnly` | unchanged |

Extend the response:

```ts
export interface AgentSessionsResponse {
  sessions: AgentSessionWithLiveness[];
  generatedAt: string;
  page?: { page: number; pageSize: number; totalCount: number; pageCount: number };
}
```

**Backward compatibility is required.** When `pageSize` is absent the route behaves exactly as
today — full set, no `page` object. The per-project route (`api-agent-sessions.ts:210-231`) and
`useAssignmentSessions` / `useProjectSessions` are untouched. Task 8 converts remaining consumers
deliberately rather than breaking them implicitly.

Clamp `pageSize` to a ceiling following `api-search.ts:79-85` (`DEFAULT_LIMIT` / `MAX_LIMIT`)
rather than inventing a new idiom. Invalid, negative, or non-integer `page` / `pageSize` fall back
to defaults — mirror `api-inbox.ts:58-61`, which ignores a malformed `limit` instead of erroring.

**Date filtering is timezone-sensitive and must not silently change.** Today the client converts
each session's `started` to the **browser's local calendar date** before comparing
(`toLocalDateKey`, `AgentSessionsPage.tsx:609-618`, used at lines 86-92 — it reads
`getFullYear()` / `getMonth()` / `getDate()`, all local). A server that compares a bare
`YYYY-MM-DD` against UTC ISO strings would shift every boundary by the UTC offset, so a session
started at 6pm local on the `startedTo` date could vanish from its own range.

Pick one and state it in the response contract:
- **Preferred:** send the browser's UTC offset (or IANA zone) alongside the dates and convert them
  to precise UTC instant bounds server-side, preserving today's behavior exactly.
- **Or** move the UI to UTC dates deliberately and label the inputs as UTC.

Do not leave it to the implementer. Task 7 requires a boundary test either way.

**`search` must stay a literal match.** Today it is JavaScript `includes()`
(`AgentSessionsPage.tsx:94-111`), so `%` and `_` are ordinary characters. A naïve SQL `LIKE` would
turn them into wildcards and change behavior. Use `instr(lower(col), lower(?)) > 0`, or `LIKE` with
an explicit `ESCAPE` clause escaping `%`, `_`, and the escape character itself. Cover the same
fields as today (`AgentSessionsPage.tsx:98-107`): `projectSlug`, `assignmentSlug`, `agent`,
`sessionId`, `path`, `description`, `summary`, `transcriptPath` — noting `projectSlug` and
`assignmentSlug` come from the `engagement` join, not `sessions`.

---

### Task 4 — Implement filtering, sorting, and paging

**File:** `src/dashboard/agent-sessions.ts` (beside `listAllSessions`, lines 774-780)

Add a paged query rather than modifying `listAllSessions` (other callers depend on it):

```ts
export interface WorkspaceScope {
  projectSlugs: string[];
  standaloneAssignmentIds: string[];
  ungrouped: boolean;
}
export interface SessionPageQuery {
  page: number; pageSize: number;
  search?: string; startedFrom?: string; startedTo?: string;
  workspaceScope?: WorkspaceScope | null;   // null = no workspace constraint
  sort: SessionSort;
  includeUsageOnly: boolean;
}
export interface SessionPageResult { sessions: AgentSession[]; totalCount: number }
export async function listSessionsPage(q: SessionPageQuery): Promise<SessionPageResult>
```

Four things this must get right:

**1. The row set is a union of two tables.** With `includeUsageOnly`, rows are tracked sessions
*plus* synthetic rows for `usage_events` session ids absent from `sessions`
(`api-agent-sessions.ts:58-110`). Page across the union, or the last pages lose orphan rows.
`sessions` and `usage_events` live in the **same** SQLite file (`usage-db.ts:225`; `session-db.ts`,
`events-db.ts`, `leases-db.ts`, `proof-db.ts` all resolve the same `~/.syntaur/syntaur.db`), so one
query can span both — not obvious from the module boundaries. `totalCount` counts the filtered
union.

**2. Workspace scope is not just project slugs.** Use `resolveWorkspaceMembers`
(`api.ts:813-831`), which returns `{ projectSlugs, standaloneAssignmentIds }` — named workspaces
can contain **standalone assignments**, and `_ungrouped` means projects with `workspace === null`
*plus* standalones with no `workspaceGroup`. Filtering on project slug alone would drop standalone
sessions from named workspaces and mis-handle `_ungrouped`. Filter through the chosen engagement's
`project_slug` **and** `assignment_id`. Resolve the scope once per request in the route, not per
row.

Usage-only orphan rows are **not** an open choice: today they carry `projectSlug: null`, so the
client's lookup (`AgentSessionsPage.tsx:77-83`) yields a null workspace, which means they are
**included by `_ungrouped` and excluded from every named workspace**. The paged query must
reproduce exactly that. Task 7 tests both directions.

**3. Spend and token sorts bypass SQL ordering — over the full union, not just the usage map.**
Cost is computed in JS, so these two sorts build an ordered id list instead. Critically, the
ordering set must be **every row that passes the filters**, not only ids present in
`listSessionUsage()`: today's comparator (`AgentSessionsPage.tsx:647-652`) reads
`right.usage?.totalCost ?? 0`, so tracked sessions with no usage events participate as zero-cost
rows. Sourcing the order from the usage map alone would silently drop them and understate
`totalCount`. Zero-fill missing usage, preserve the existing `started` DESC tie-break, then add
`session_id` as the final stable key. The aggregate is bounded by `usage_events` (2,562), not by
`sessions`.

**4. Enrich the page, not the set.** Call `enrichSessions` and `attachUsage` on the page's rows
only. The full-set path when `pageSize` is absent keeps today's behavior.

Add a stable secondary sort on `session_id` to **every** ordering, so a row cannot appear on two
pages or be skipped when timestamps tie.

---

### Task 5 — Wire the hook to page params

**File:** `dashboard/src/hooks/useProjects.ts:770-776`

```ts
export function useAgentSessions(opts?: {
  includeUsageOnly?: boolean;
  page?: number; pageSize?: number;
  search?: string; startedFrom?: string; startedTo?: string;
  workspace?: string | null; sort?: SessionSort;
  enabled?: boolean;
}): FetchState<AgentSessionsResponse>
```

`enabled` is required, not optional polish: `useFetch` is **module-private** and already takes an
`enabled` third argument used to hold back the command palette's indexes until it first opens
(`useProjects.ts:543-565`). Task 8 needs to defer `CreateSessionViewDialog`'s fetch, and without
`enabled` plumbed through `useAgentSessions` there is no way for a caller to reach it. Pass it
straight through to `useFetch`.

Calling with no arguments must keep producing today's URL, so Task 8 can convert consumers one at a
time.

**The websocket criterion falls out of this for free, deliberately.** `useFetch` is URL-keyed and
its WS handler calls `refetch()`, which bumps `fetchCount` and re-requests **the same `activeUrl`**
(`useProjects.ts:567-569`, `604-629`, `644-651`). Once page state is in the URL, an
`agent-sessions-updated` broadcast refetches only the current page. Page position and `selectedIds`
are React state, untouched by a refetch.

Preserve two properties: leave `resetDataOnUrlChange` at its default `false` so changing page keeps
current rows on screen while the next loads (stale-while-revalidate, lines 597-601) rather than
flashing a skeleton; and debounce `search` so typing does not fire a request per keystroke.

---

### Task 6 — Page the UI, and fix selection semantics

**File:** `dashboard/src/pages/AgentSessionsPage.tsx`

Add `page` and `pageSize` state (default 100; offer `[50, 100, 250, 500]`) and pass all filter state
to the hook. Delete the client-side filter/sort memo at lines 69-115 — the server owns it now.
Render `data.sessions` directly; it is already the page.

Reset `page` to 0 when `search`, `startedFrom`, `startedTo`, `sort`, or `workspace` changes. Clamp
`page` to `pageCount - 1` when a filter change shrinks the result set.

Controls below the table (and above it when `pageCount > 1`): `Page {page+1} of {pageCount}`,
`{totalCount} sessions`, Previous/Next disabled at the boundaries, and a page-size select. Match
`FilterBar` / `SearchInput` styling. Label the controls and wrap them in
`<nav aria-label="Pagination">` — commit `4ac2cdf` established labeled controls as this codebase's
bar.

**Selection across pages.** Today `toggleSelectAll` (lines 141-147) *replaces* `selectedIds` with
the full eligible set and clears it entirely. Substituting the page's ids without changing that
logic would discard other pages' selections on select, and wipe every page's selection on clear:

- **Select-all acts on the current page**, and the UI says so. A header checkbox that arms a
  destructive bulk delete (`handleDelete`, line 149) across 2,443 unseen rows is the more dangerous
  default.
- Selecting **unions** the page's `selectableSessionIds` into `selectedIds`.
- Clearing **subtracts** only the page's eligible ids.
- `headerCheckState` is computed over the current page.
- The bulk action bar states the absolute count (`"Delete 37 selected"`).
- The pruning effect at lines 60-67 drops ids missing from `data`. Under paging `data` is **one
  page**, so as written it would delete the rest of the selection on every page change. Scope
  pruning to ids the current page could have contained, or drop it and prune on action. **This is
  the single most likely bug in this task.**

`src/utils/session-select.ts` needs no signature change — both functions take an arbitrary
`readonly SelectableSession[]`.

---

### Task 7 — Tests

**Endpoint contract** — new `src/__tests__/dashboard-api-agent-sessions-paging.test.ts`. Copy the
harness from `src/__tests__/dashboard-api-agent-sessions-usage.test.ts:1-47`, which sets
`SYNTAUR_HOME` to a temp dir, calls `initSessionDb()` + `initUsageDb()` against the same file, and
mounts the router on an ephemeral port. Cover:

- a page returns exactly `pageSize` rows with correct `totalCount` / `pageCount`
- last page returns the remainder; a page past the end returns empty with `totalCount` intact
- **filters span the full set** — seed a match that sorts to ~position 2,000, filter, assert it
  returns on page 0
- every sort, including `spend_desc` / `tokens_desc` with usage seeded via `upsertEvent`
- **`spend_desc` includes tracked sessions with no usage events**, ordered as zero-cost with the
  `started` DESC tie-break (the Task 4 point 3 trap)
- usage-only orphan rows appear in the paged union and count toward `totalCount`
- workspace scoping: a **standalone** assignment session in a named workspace is included, and
  `_ungrouped` returns the right set
- usage-only orphan rows appear under `_ungrouped` and **not** under any named workspace
- date filtering at a local-day boundary: a session started late in the evening local time is
  included by a `startedTo` equal to its local date (the timezone contract from Task 3)
- search treats `%` and `_` literally
- no row duplicated or skipped across consecutive pages when `started` values tie
- invalid `page` / `pageSize` / `sort` fall back to defaults rather than erroring
- omitting `pageSize` returns the full set and no `page` object (backward compatibility)

**Paging/selection helpers** — `dashboard/src/lib/__tests__/`. Put the union/subtract selection math
in a pure exported helper so it is testable: this codebase has no `@testing-library`, and
`vitest.dashboard.config.ts` includes only `dashboard/src/**/*.test.ts`, not `.tsx`. Cover
select-page-with-prior-selection-elsewhere, clear-page-preserves-others, and `headerCheckState` over
a fully-selected page while the full set has more.

Run: `npx vitest run src/__tests__/`, `npx vitest run --config vitest.dashboard.config.ts`
(19 files / 206 tests currently green).

---

### Task 8 — Convert the Overview consumers

**Files:** `dashboard/src/components/dashboard/widgets/AgentSessionsWidget.tsx:47`,
`dashboard/src/components/dashboard/widgets/SessionViewResults.tsx:26-48`,
`dashboard/src/components/CreateSessionViewDialog.tsx:58`

All three call `useAgentSessions()` unbounded, so **the Overview page pays the same 2.9 MB today**.

`applySessionLimit` (`sessionFilters.ts:178-185`) does **not** help — it slices after the full
response is parsed. `SessionViewResults` already does exactly that at lines 45-48 and still
downloads everything.

Handle each by what it actually needs, and **assign one data owner per state**:

- **`AgentSessionsWidget`** with no saved view — a recent-sessions rail. `RecentSessionsRail`
  (lines 25-42) renders **every** session handed to it and has no internal cap, so the bound has to
  come from the request. Use a concrete one:
  `useAgentSessions({ pageSize: 10, page: 0, sort: 'started_desc', enabled: !viewId })`.
- **`SessionViewResults`** — a saved view applies `sessionFilters` predicates and sort across the
  **complete** set, and its `config.limit` is *optional*, so there is not always a display-sized
  bound. An arbitrary bounded page would silently drop matching older sessions and return wrong
  results. Either add server-side support for the saved-view predicates first, or **keep the full
  fetch here and record the justification** — the acceptance criterion permits a full-set consumer
  when the reason is documented. Do not quietly bound it.
- **Duplicate fetch:** when a saved view is selected, `AgentSessionsWidget` still runs its own
  `useAgentSessions()` alongside `SessionViewResults`. Disable the widget's query when `viewId` is
  set (`enabled: !viewId`) so exactly one component owns the request in each state.
- **`CreateSessionViewDialog`** needs full facet coverage (project/agent lists), so defer rather
  than bound it: `useAgentSessions({ enabled: open })` via the flag added in Task 5. Leave a
  one-line comment saying why it stays unbounded, and verify a closed dialog issues no request.

---

### Task 9 — Measure and record

Measure before and after with Chrome DevTools Performance on `http://localhost:4800/agent-sessions`
(`syntaur dashboard --port 4800`): payload size, fetch duration, `JSON.parse` duration, React
render/commit, total time to interactive. Confirm the Overview page's session payload dropped too.

Write before/after into the assignment's `progress.md` — an explicit acceptance criterion. Record in
`decision-record.md`: the union-of-two-tables constraint, why spend sorting is not a SQL `ORDER BY`,
the workspace-scope policy chosen for usage-only rows, and the page-scoped select-all decision.

---

## Verification

```bash
cd /Users/brennen/syntaur
npx vitest run src/__tests__/                        # endpoint + shared-module tests
npx vitest run --config vitest.dashboard.config.ts   # 19 files currently green, plus new
npm run typecheck
npm run build --prefix dashboard
syntaur dashboard --port 4800
```

Then confirm with `EXPLAIN QUERY PLAN` that a default `started_desc` page uses
`idx_sessions_started`.

Manual: filter to something on the last page and confirm it is reachable; select rows on page 1,
move to page 2, select more, confirm the count accumulates and the bulk bar states it; return to
page 1 and confirm the original selection survived; start any agent and confirm the websocket
refresh updates the current page without resetting page position or selection.

---

## Risks

| Risk | Mitigation |
|---|---|
| Pruning effect wipes selection on page change | Called out in Task 6 as the most likely bug; cross-page selection test |
| Spend sort drops zero-usage tracked sessions | Task 4 point 3 orders over the full filtered union with zero-fill; dedicated test |
| Standalone-assignment sessions lost from workspace filters | `resolveWorkspaceMembers` returns standalone ids too (Task 4 point 2); dedicated test |
| Saved views silently return wrong results | Task 8 forbids bounding `SessionViewResults` without server-side predicate support |
| Rows duplicated or skipped across pages on tied `started` | Stable `session_id` secondary sort on every ordering; explicit test |
| Search behavior changes on `%` / `_` | Literal matcher specified in Task 3; explicit test |
| Date filters shift by the UTC offset | Timezone contract fixed in Task 3; local-day-boundary test |
| New shared module unresolvable at build time | Task 1 registers the alias in vite + tsconfig explicitly; there is no wildcard mapping |
| Existing consumers break on the response change | `pageSize` absent ⇒ today's exact behavior; backward-compat test |
| Missing index makes paging pointless server-side | Task 2 lands early; verified by `EXPLAIN QUERY PLAN` |

---

## Review Log

| # | Tier | Critical | Major | Minor | Disposition |
|---|------|----------|-------|-------|-------------|
| 1 | gpt-5.6-terra/high | 1 | 4 | 0 | fixed all; looping |
| 2 | gpt-5.6-terra/high | 0 | 4 | 2 | fixed all; looping |
| 3 | gpt-5.6-terra/high | 0 | 3 | 1 | fixed all; cap reached |

## Plan Review Summary

**Overall Verdict:** NEEDS REVISION
**Review method:** adaptive external review loop — cap of 3 iterations reached without convergence

Each round produced well-formed, source-verified findings, and each round's findings were fixed in
the plan before the next. The loop did not converge: round 3 still returned 3 major findings, and
its fixes have been applied but **not externally re-verified**.

The findings are getting narrower — round 1 rejected the plan's central approach, round 3 found
build wiring, timezone semantics, and a missing constant — which suggests the plan is close. It is
not certified ready.

### Round 3 findings, fixed but unverified
- Shared-module alias: no wildcard `@shared/*` exists; `session-sort` must be registered in
  `dashboard/vite.config.ts` and `dashboard/tsconfig.json` (verified against source — the reviewer
  was correct).
- Date-filter timezone semantics: `toLocalDateKey` uses browser-local dates; a bare `YYYY-MM-DD`
  sent server-side would shift boundaries (verified at `AgentSessionsPage.tsx:609-618`).
- Usage-only orphan workspace placement: current behavior puts them in `_ungrouped` only; the plan
  had wrongly left this an implementation choice.
- `RecentSessionsRail` has no internal display cap, so the widget's bound must be an explicit
  `pageSize`.

### Suggested next step
`/planner:plan --review-start gpt-5.6-terra/xhigh --max-reviews 2` on this file to confirm round
3's fixes and drive to convergence.
