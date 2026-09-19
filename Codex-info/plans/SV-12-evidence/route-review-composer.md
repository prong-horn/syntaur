# SV-12 route / URL-state review — Composer 2.5 (independent)

**Reviewer:** Cursor Composer 2.5 (standard), separate session  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Date:** 2026-09-19  
**Inputs:** `/tmp/syntaur-sv12/resume-fixes-composer-handoff.md`, plan `Codex-info/plans/SV-12-dashboard-six-pages.md` (Revision 3), in-scope source + tests  
**Scope:** Legacy hash preservation, Board `projectVisibility` / URL sync, `BoardProjectPanel` archived facet. **Out of scope:** BoardDialogs / NavigationHotkeys (`dialog-fixes-luna.md`), full browser QA matrix, unfinished tests elsewhere.

**NODE_OPTIONS:** unset for probes below.

---

## Verdict

| Overall | High | Medium | Low |
|---------|------|--------|-----|
| **READY** (owned route/archive URL scope) | **0** | **0** | **2** |

The Composer handoff claims for Luna **[M] hash drop** and **[M] archived facet / control mismatch** are **confirmed in code** for the primary legacy → Board paths and URL-authoritative `projectVisibility`. Active kanban/table under `projectVisibility=archived` matches plan §Board filters (`projectVisibility` scopes **only** the project panel; `/api/tickets` feed stays active-project-only).

SV-12 **closure** still depends on separate dialog review and browser QA per Revision 3; this review does not accept those.

---

## Luna findings — independent disposition

### [M] Legacy redirect drops hash fragments

**Handoff:** FIXED (verified + hardened)  
**Review:** **Agree — fixed for direct legacy routes**

| Layer | Evidence |
|-------|----------|
| Resolver | `resolveLegacyRoute(pathname, search, hash)` appends `hash` on destinations (e.g. `/tickets` → `/board?…${hash}`, `/archive`, `/projects/…`, ticket edits, sessions, library, help). See `dashboard/src/lib/legacyRoutes.ts` lines 79–102, 94, 138, etc. |
| Redirect component | `LegacyRedirect` passes `location.hash` into the resolver and navigates with `{ pathname, search, hash }` via `legacyDestinationToLocation()` (URL parse), not a single string `to`. See `dashboard/src/components/LegacyRedirect.tsx` lines 5–19. |
| Board URL updates | `useBoardFilters` `updateUrl` uses `navigate({ pathname, search, hash: location.hash })`. See `dashboard/src/hooks/useBoardFilters.ts` lines 171–177. |
| Tests | `legacyRoutes.test.ts` — `/tickets?status=review#x`, `/projects/qa-atlas?tab=archive#keep`; `LegacyRedirect.test.tsx` — mounted `/tickets?status=review#x` → `/board?status=review#x`; `useBoardFilters.route.test.tsx` — hash survives legacy redirect **and** post-bootstrap `setHistory('all')` URL sync. |

**Probe (this session):** `npm run test:dashboard -- --run` on the three files above — **12/12 passed** (807ms).

### [M] Archived project mode / facet selection mismatch

**Handoff:** FIXED for control + panel; active board feed under archived facet intentional  
**Review:** **Agree — control aligned with URL; panel scoped; feed behavior per plan**

| Layer | Evidence |
|-------|----------|
| Plan | `SV-12-dashboard-six-pages.md` — `projectVisibility` is URL-only, scopes **only** project panel; board feed remains active-project-only (lines ~63, 77). |
| URL grammar | `parseBoardUrlParams` / `serializeBoardUrlParams` — `projectVisibility` normalized (`active` default), omitted when default. `boardUrlParams.ts` lines 107–111, 146, 252–254. |
| Hook state | `state.projectVisibility` read from `urlState` (not a stale local mirror); `setProjectVisibility` only calls `updateUrl`. `useBoardFilters.ts` lines 356, 388. |
| Panel UI | `<select value={state.projectVisibility}>`; `visibleProjects` returns `[]` when `archived`; `archivedProjects` empty when `active`. `BoardProjectPanel.tsx` lines 58–67, 187–195. |
| Board chrome | `showProjectPanel` true when `projectVisibility !== 'active'`. `BoardPage.tsx` line 156. |
| Tests | Direct URL `?projectVisibility=archived&panel=projects` → `|archived`; user `setProjectVisibility('archived')` updates query + state; mounted panel select `archived` + empty list while fixture has active project title absent from JSON. `useBoardFilters.route.test.tsx` lines 58–101. |

**Not a defect (confirmed):** Tickets still visible in kanban/table with `projectVisibility=archived` — required by plan, not panel-only filtering of the main feed.

---

## Findings (independent)

### Low — workspace-prefixed legacy URLs + hash (residual, not in handoff diff)

`App.tsx` `WorkspacePrefixRedirect` still uses string `Navigate` to ``${stripped}${search}${hash}`` (lines 13–17). React Router 7 was observed (handoff) to drop fragments on some string-only `Navigate` targets; primary legacy paths were hardened in `LegacyRedirect`, but **`/w/:workspace/...#fragment` may still lose the hash on the first hop** before `LegacyRedirect` runs. `legacyRoutes.ts` can resolve prefixed paths if called with full pathname + hash, but the live route order strips workspace first via string navigation.

- **Severity:** Low (narrow URL family; unit test covers strip + resolve without hash only).
- **Action:** Optional follow-up — mirror `legacyDestinationToLocation` object navigation in `WorkspacePrefixRedirect`, plus one mounted test. **Not required to reject owned handoff scope** (direct `/tickets#x` etc. are fixed).

### Low — hash coverage gaps in tests (non-blocking)

No mounted test for `/archive#keep` or `/w/ws-1/tickets#x`. Resolver unit tests already append hash for `/archive` via shared `${hash}` suffix pattern; risk is integration-only for workspace hop.

---

## Regressions checked (read-only)

- `legacyDestinationToLocation` splits `?query` and `#hash` correctly (`LegacyRedirect.test.tsx` unit case).
- Legacy `/archive` → `/board?projectVisibility=archived&panel=projects` (`legacyRoutes.test.ts`).
- Conflicting `?project=` query loses to path slug (`legacyRoutes.test.ts`).
- Bootstrap `useEffect` re-serializes URL with `urlState.projectVisibility` / `panel` / `dialog` so archived facet is not wiped on preference sync (`useBoardFilters.ts` lines 222–237).
- No edits made to source or tests in this review.

---

## Probes run (scoped)

| Command | Result |
|---------|--------|
| `unset NODE_OPTIONS && npm run test:dashboard -- --run dashboard/src/lib/__tests__/legacyRoutes.test.ts dashboard/src/components/__tests__/LegacyRedirect.test.tsx dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx` | **PASS** (12 tests) |

Full backend / full dashboard suite **not** rerun (per orchestration: change limited to dashboard routes/state; no backend edits in handoff).

---

## Handoff cross-check

| Handoff claim | Independent result |
|---------------|-------------------|
| Hash fix in resolver + `LegacyRedirect` + `useBoardFilters` | **Confirmed** |
| Archived control + panel; feed intentional | **Confirmed** vs plan |
| Focused 12/12 tests | **Reproduced** |
| Dialog / full QA out of scope | **Honored** (not reviewed here) |

---

## Summary for root orchestration

- **Route/archive URL slice:** **READY** — accept Composer handoff closure for hash + `projectVisibility` owned scope.
- **Remaining SV-12:** dialog independent review, browser matrix, optional workspace-hash hardening (low).
