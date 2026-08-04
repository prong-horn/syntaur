Tests and typecheck pass (19 new tests, 206 dashboard tests, `tsc --noEmit` clean), so this is a logic review, not a build review. Here are concrete findings.

## CRITICAL

**C1 — Orphan misclassification inflates `_ungrouped` and its `totalCount` with tracked sessions from other workspaces**
- LOCATION: `src/dashboard/api-agent-sessions.ts:366-374` (the `pageSessions` merge path)
- ISSUE: The merge path builds `tracked = new Set(trackedKeys.map((k) => k.sessionId))` from the **filtered** sort keys, then treats any `usage_events` session id not in that set as an orphan. But `trackedKeys` is the *post-filter* set. When the request scopes to `_ungrouped` with `includeUsageOnly=1`, a tracked session that actually belongs to a **named** workspace (or a standalone assignment) is excluded from `trackedKeys` by the workspace WHERE clause, so it falls out of `tracked`. It then re-enters as a synthetic `usageOnly: true` orphan via `orphanPassesFilters`, which (correctly for *real* orphans) admits workspace-less rows into `_ungrouped`. The result: real tracked sessions are re-surfaced under `_ungrouped` with wrong metadata (`projectSlug: null`, `usageOnly: true`) and `totalCount`/`pageCount` are inflated by them. This is reachable from the shipped default — `AgentSessionsPage` always sets `includeUsageOnly: true`, and the route `/agent-sessions/w/_ungrouped` sets `workspaceScope.ungrouped`. I confirmed it with a scratch test: seeding `alpha-sess` in project `alpha` (workspace `gridiron`) + usage, then `GET ?workspace=_ungrouped&includeUsageOnly=1` returns `[{id:'alpha-sess', usageOnly:true}]` instead of `[]`. The full-set backward-compat path (`attachUsage`, `api-agent-sessions.ts:105`) does **not** have this bug because its `tracked` is built from the *unfiltered* session list — which is exactly the fix. The existing test "puts unattributed and usage-only rows in `_ungrouped`…" does not catch this because its `bound` session has no usage events.
- FIX: Build `tracked` from an unfiltered `SELECT session_id FROM sessions` (cheap), independent of the filters, so "orphan" keeps its true meaning ("usage id with no `sessions` row"). Only real orphans should reach `orphanPassesFilters`. Add a regression test: a tracked session in a named workspace **with usage** must not appear under `_ungrouped`.

## MAJOR

None beyond C1. The items below are MINOR.

## MINOR

**M1 — Cross-field substring search no longer matches across field boundaries**
- LOCATION: `src/dashboard/agent-sessions.ts:866-869` (`buildSessionFilters`, per-column `instr(... OR ...)`); contrast old client at the deleted `AgentSessionsPage.tsx` `filteredSessions` memo (`haystack = [...].join(' ').toLowerCase(); haystack.includes(query)`).
- ISSUE: The old comparator concatenated all searchable fields with spaces and ran one `includes()`, so a multi-word query like `"alpha task"` matched when `projectSlug='alpha'` and `assignmentSlug='task'` were adjacent in the concatenation. The new SQL path tests each column independently, so a query that spans two fields matches nothing. Single-token and same-field searches are unaffected.
- FIX: Concatenate in SQL to preserve the old semantics: `instr(lower(COALESCE(e.project_slug,'')||' '||COALESCE(e.assignment_slug,'')||' '||COALESCE(s.agent,'')||' '||...), lower(?)) > 0`, or document the behavior change deliberately.

**M2 — Duration sort disagrees between the two paths and from the old client for live sessions**
- LOCATION: SQL `ORDER_BY['duration_desc'/'duration_asc']` at `src/dashboard/agent-sessions.ts:847-849` (`julianday(COALESCE(s.ended, s.started))` ⇒ live sessions get duration 0 and sort last via `s.ended IS NULL`) vs JS `durationMinutes`/`compareKeys` at `api-agent-sessions.ts:223-225` (live ⇒ `now − started`, sorts first under desc). The old client `getDurationMinutes` matched the JS path (live = elapsed).
- ISSUE: The two code paths order live sessions differently for duration sorts. The main page always uses `includeUsageOnly: true` ⇒ merge path ⇒ old behavior, so no current consumer hits the SQL duration path, but the contract diverges and a future paged consumer without `includeUsageOnly` will get different ordering than the page.
- FIX: Pick one definition and mirror it. If live-as-elapsed is intended (old behavior), the SQL path can't express it deterministically; route duration sorts through the merge path too, or accept live-sorts-last in both and drop the `now`-based branch.

**M3 — `started_desc` tie-break direction differs between paths**
- LOCATION: SQL `started_desc: 's.started DESC, s.session_id DESC'` (`agent-sessions.ts:842`) vs JS `b.started.localeCompare(a.started) || a.sessionId.localeCompare(b.sessionId)` (`api-agent-sessions.ts:221`, sessionId **ASC**).
- ISSUE: For tied `started`, the SQL path orders `session_id` DESC, the merge path ASC. No cross-page duplication within a single consumer (each consumer picks one path deterministically), so this is a contract/cosmetic divergence, not a paging-correctness bug. Other column sorts (`started_asc`, `assignment_asc`, `agent_asc`) agree on direction.
- FIX: Align the secondary-sort direction in both paths.

**M4 — Collation divergence for `agent_asc` / `assignment_asc` between SQL and JS**
- LOCATION: `ORDER_BY['agent_asc'/'assignment_asc']` (SQLite BINARY collation, case-sensitive) vs `compareKeys` (`localeCompare`, locale-aware/case-insensitive). The old client used `localeCompare`, so the SQL path diverges from prior behavior for mixed-case agent/assignment names (e.g. `"Claude"` before `"alpha"` under BINARY, reversed under `localeCompare`).
- FIX: Apply `COLLATE NOCASE` on those columns in the SQL ORDER BY, or accept the divergence and document it.

**M5 — Date filter uses the *current* browser offset, not the offset of the filtered date**
- LOCATION: `dashboard/src/hooks/useProjects.ts` `params.set('tzOffset', String(new Date().getTimezoneOffset()))` + `src/dashboard/api-agent-sessions.ts` `localDateToUtcBounds`.
- ISSUE: `getTimezoneOffset()` is captured at request time. If the user filters a calendar date in a different DST period than "now" (e.g. browsing in January, filtering a July date in a DST-observing zone), the bounds are off by the DST delta (typically 1 hour), mis-including/excluding sessions near the day boundary. The conversion itself is correct for the offset it receives (verified both signs: UTC-6 → `2026-07-01T06:00:00.000Z`/`2026-07-02T05:59:59.999Z`; UTC+8 sign handled correctly via negative offset).
- FIX: Send the offset applicable to each date, e.g. `new Date(\`${date}T12:00:00\`).getTimezoneOffset()` per date, or send an IANA zone and resolve server-side.

**M6 — Orphan search surface drops the synthetic `'unknown'` agent label**
- LOCATION: `orphanPassesFilters` at `src/dashboard/api-agent-sessions.ts:168-189` builds the haystack from `[sessionId, usage.tool ?? '', usage.cwd ?? '']`, but the orphan row's `agent` is `usage.tool || 'unknown'` (`usageOnlyRow`). The old client's haystack included `session.agent`, so searching `"unknown"` matched tool-less orphans; the new orphan filter never matches `"unknown"` for those rows.
- FIX: Include `(usage.tool || 'unknown')` in the haystack, or accept the narrower surface as deliberate.

**M7 — The 30s `tick` interval is now dead, and live-duration ranks no longer auto-refresh**
- LOCATION: `dashboard/src/pages/AgentSessionsPage.tsx:66` (`const [, setTick] = useState(0);`) and `:95-101` (`setInterval(() => setTick(...), 30000)`). `tick` is no longer read anywhere — the `filteredSessions` useMemo that depended on it was deleted.
- ISSUE: The interval now only causes a pointless re-render every 30s (no refetch, since `tick` isn't in the URL). As a side effect, the old behavior where live-session durations re-sorted every 30s is silently gone — a live session's duration-rank updates only on a websocket broadcast now.
- FIX: Remove the interval, or wire it to a `refetch()` if periodic live-duration refresh is still desired.

**M8 — `DEFAULT_PAGE_SIZE` on the server is unused**
- LOCATION: `src/dashboard/api-agent-sessions.ts:248`. Only `MAX_PAGE_SIZE` is referenced (`:520`). `pageSize` presence is the opt-in; a malformed `pageSize` opts *out* of paging rather than falling back to the default, so the constant is never applied.
- FIX: Remove it, or use it as the fallback when `pageSize` is present but malformed (the plan suggested mirroring `api-inbox.ts`, which falls back to a default rather than degrading to the full set — current behavior degrades to the full set, which is reasonable but leaves the constant dead).

**M9 — `tzOffset` accepts non-integer values**
- LOCATION: `src/dashboard/api-agent-sessions.ts` route handler — `const tzOffset = Number(req.query.tzOffset); const offsetMinutes = Number.isFinite(tzOffset) ? tzOffset : 0;` then `localDateToUtcBounds(..., offsetMinutes, ...)`.
- ISSUE: `Number("5.5")` is finite and produces a fractional-minute bound shift. Real `getTimezoneOffset()` is always an integer, so impact is nil in practice, but the validation is looser than the contract implies.
- FIX: Require `Number.isInteger(tzOffset)`; fall back to 0 otherwise.

## Items I checked and found correct

- **SQL injection / input validation**: `sort` is whitelist-validated (`isSessionSort`) and used only as a key into a static `ORDER_BY` map; `page`/`pageSize` are integer-parsed and bound as LIMIT/OFFSET params; `search` is bound via `instr(?, ?)` (parameterized, and `%`/`_` are literal — covered by a test); `startedFrom`/`startedTo` are regex-validated then bound; workspace slugs/ids are bound via `map(()=>'?')`. No interpolation of untrusted input.
- **Stable secondary sort**: every SQL ORDER BY and every `compareKeys` branch ends in `session_id`, so within a single consumer no row is duplicated across pages or skipped on tied `started` (verified by the tie test).
- **Spend/tokens include zero-usage tracked sessions**: the merge path zero-fills `cost`/`tokens` for tracked keys with no usage entry, ranking over the full filtered tracked set, matching the old `right.usage?.totalCost ?? 0`. Covered by test.
- **Path selection**: `!includeUsageOnly && !usageSort` ⇒ SQL; otherwise merge. Consistent with where orphans/cost are needed.
- **Cross-page selection union/subtract**: `toggleSelectAll` unions the page's `selectableSessionIds` on select and subtracts only the page's eligible ids on clear; the dangerous old "prune to `data`" effect is correctly removed (would have wiped other pages under paging); usage-only rows are non-selectable (checkbox disabled). The separate "Clear Selection" action-bar button does a global clear (`new Set()`), which is intentional and distinct from the page-scoped header control.
- **Page-clamp effect**: deps `[pageMeta, page]`; clamps to `pageCount-1` when a refetch shrinks the set beneath the current page; no loop (after clamp, condition is false).
- **Reset-to-0 effect**: deps `[debouncedSearch, startedFrom, startedTo, sort, pageSize, workspace]`; a wasted (then-cancelled) fetch of the old page index fires between the state change and the effect, but `useFetch`'s effect cleanup discards it — no stale data, just one extra request.
- **Backward compat**: omitting `pageSize` returns the exact pre-change shape (full set, no `page` object) via the unchanged `listAllSessions`+`attachUsage` path; `useAgentSessions({})` builds the same URL as before (`/api/agent-sessions` or `?includeUsageOnly=1`).
- **`localDateToUtcBounds` math**: correct for both positive (west) and negative (east) offsets and for start/end edges, per the unit tests.
- **`insertClosedEngagement` assignmentId fix** (`agent-sessions.ts:303`): a legitimate forward-looking bugfix; note that historical closed engagements already in the DB still carry `assignment_id IS NULL`, so pre-existing standalone-closed sessions will not match named-workspace filters until re-registered (data migration gap, not a code bug).

The headline issue is **C1**; everything else is polish.
