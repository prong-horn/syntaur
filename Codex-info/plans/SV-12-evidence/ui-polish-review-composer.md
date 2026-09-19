# SV-12 UI polish — independent review (Composer 2.5)

**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Plan:** `Codex-info/plans/SV-12-dashboard-six-pages.md` (Revision 3)  
**Handoff:** `/tmp/syntaur-sv12/ui-polish-composer-handoff.md`  
**Scope:** Narrow ticket containment (`ContentTabs` / `TicketPage` / `TicketHeader`), workspace prefix + hash (`LegacyRedirect`), Board URL history / normalization (`useBoardFilters`).  
**Method:** Read-only code trace, focused unit tests (NODE_OPTIONS unset), preserved browser artifacts (`ui-polish/browser-results.json`). No live server started in this session.

---

## Verdict

| Slice | Result | high | medium | low |
| --- | --- | ---: | ---: | ---: |
| Legacy redirect + bootstrap URL sync (inbox → legacy → back) | **READY** | 0 | 0 | 1 |
| Workspace `/w/:workspace/...` hash preservation | **READY** | 0 | 0 | 1 |
| Narrow ticket horizontal overflow (~390px) | **READY** | 0 | 0 | 1 |
| Board URL `replace` vs plan (dialogs / user history) | **CHANGES_REQUIRED** | 0 | 1 | 2 |
| **Overall (merge before closing qa-composer [L] rows)** | **CHANGES_REQUIRED** | **0** | **1** | **5** |

Handoff claims for legacy back, workspace hash, and narrow overflow are **confirmed** by code + tests + existing Playwright artifacts. The global `replace: true` on `updateUrl` fixes the legacy stack bug but **conflicts** with the plan’s dialog back/forward contract for the primary UI path (`setDialog`).

---

## What works (evidence)

### 1. Legacy back after `replace` redirect (handoff root cause)

**Mechanism:** `LegacyRedirect` / `WorkspacePrefixRedirect` use `<Navigate replace />`. Post-redirect, `useBoardFilters` sync calls `navigate(..., { replace: true })` so preference/bootstrap serialization does not push a second `/board` entry.

```171:178:dashboard/src/hooks/useBoardFilters.ts
  const updateUrl = useCallback(
    (patch: Parameters<typeof serializeBoardUrlParams>[1]) => {
      const next = serializeBoardUrlParams(searchParams, patch);
      if (boardUrlParamsEqual(searchParams, next)) return;
      navigate(
        { pathname: location.pathname, search: `?${next}`, hash: location.hash },
        { replace: true },
      );
```

**Unit:** `useBoardFilters.route.test.tsx` — inbox → `/tickets?...` → `navigate(-1)` → `/inbox` (6/6 in focused run).  
**Browser:** `ui-polish/browser-results.json` — `legacy-back-forward` PASS (`http://127.0.0.1:54851/inbox`).  
**Repro (manual):** Open `/inbox` → navigate to `/tickets?status=review#x` → browser Back → expect `/inbox`, not an intermediate `/board`.

### 2. Workspace prefix + hash

**Mechanism:** `WorkspacePrefixRedirect` builds object `to` via `legacyDestinationToLocation()` (hash-safe); two-hop routing (`/w/...` → canonical path → `LegacyRedirect`) covered in tests.

```10:16:dashboard/src/components/LegacyRedirect.tsx
export function WorkspacePrefixRedirect() {
  const location = useLocation();
  const stripped = location.pathname.replace(/^\/w\/[^/]+/, '') || '/';
  const target = legacyDestinationToLocation(`${stripped}${location.search}${location.hash}`);
  return <Navigate to={target} replace />;
}
```

**Unit:** `LegacyRedirect.test.tsx` — workspace strip preserves `#x` (3/3 focused run).  
**Browser:** `workspace-legacy-hash` PASS — final URL includes `/board` and `#x`.

### 3. Narrow ticket containment

**Mechanism:** `ContentTabs` — `min-w-0` / `max-w-full` / `overflow-hidden` on chrome; `shrink-0` triggers; `TicketPage` grid `min-w-0`; `TicketHeader` `flex-wrap` + full-width action row below `lg`.

**Browser:** `narrow-ticket-overflow` PASS — `horizontalOverflow=false` at 390×850 on `/t/QA-1`.  
**Note:** No dedicated unit/CSS test; reliance on Playwright fixture ticket `QA-1` in ui-polish harness.

**Focused unit run (this review):**

```text
npm run test:dashboard -- --run \
  dashboard/src/components/__tests__/LegacyRedirect.test.tsx \
  dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx
→ 9/9 passed
```

---

## Issues

### Medium — Dialog back/forward via Board UI does not close dialog (plan § line 57)

**Contract (plan):** “Browser back/forward closes dialogs predictably, retains filters, and restores focus to the opener.”

**Actual:** Every `setDialog` / `setPanel` / filter action goes through `updateUrl`, which **always** uses `replace: true` (`useBoardFilters.ts` 357–361). Opening a dialog from Board chrome replaces the current history entry instead of pushing one, so **Back leaves the Board** rather than clearing `dialog=`.

**Concrete repro:**

1. Go to `/board` (e.g. from sidebar).
2. Click **New ticket** (or any control calling `actions.setDialog('new-ticket')` in `BoardProjectPanel.tsx`).
3. URL shows `?dialog=new-ticket`; dialog is open.
4. Press browser **Back**.
5. **Observed:** Navigate to the previous route (e.g. `/inbox`), dialog still logically abandoned; **not** `/board` with dialog closed and filters unchanged.
6. **Expected per plan:** Back to `/board` with `dialog` omitted; filters unchanged; focus restored (`BoardDialogs` capture on open — `BoardDialogs.tsx` 40–54).

**Contrast (inconsistent):** Hotkey `n` uses `navigate('/board?dialog=new-ticket')` **without** replace (`NavigationHotkeys.tsx` 76–78), so Back **does** drop `dialog=` when the dialog was opened via `n`. Same product surface, two history semantics.

**Relation to handoff:** Handoff explicitly accepts replace for **filter** tweaks; it does **not** exempt `dialog` / `panel` ephemeral keys from the plan’s back/forward dialog rule. This is a **regression risk introduced by scoping `replace` to all `updateUrl` callers**, not merely bootstrap normalization.

**Suggested direction (review only, no edit):** Use `replace: true` only for bootstrap/preference normalization (the post-legacy `useEffect` at 225–240) and for no-op-equivalent URL canonicalization; use default **push** for `setDialog`, `setPanel`, and other explicit user mutations if dialog/filter undo via history remains required.

---

### Low — Filter changes no longer create history entries

**Actual:** User-driven filter/sort/view updates all call the same `updateUrl` with `replace: true`.

**Repro:** On `/board`, change status filter twice → Back once → leaves Board instead of restoring prior filter URL.

**Disposition:** Handoff documents this as an intentional tradeoff for legacy-back correctness. Acceptable **only if** product explicitly deprioritizes filter undo via browser history; not called out in Revision 3 plan text.

---

### Low — Verification gaps

| Gap | Detail |
| --- | --- |
| Dialog back | No unit or browser row in `verify-ui-polish.mjs` (only legacy inbox back). Prior dialog reviews noted “history-back not mounted.” |
| Narrow overflow | Browser-only on `QA-1`; no regression test if tab labels/count change. |
| Workspace strip | `WorkspacePrefixRedirect` uses pathname regex, not `stripWorkspacePrefix()` from `legacyRoutes.ts`; behavior matches tests today, slight duplication. |

---

## Normalization vs user-initiated history (requested check)

| Event | `replace` today | Correct target |
| --- | --- | --- |
| Legacy redirect → board + prefs merge in `useEffect` | yes | **yes** — fixes extra stack entry (proven). |
| User opens board dialog via button (`setDialog`) | yes | **no** — should push (plan). |
| User changes filters on board | yes | **product call** — handoff accepts; plan silent. |
| User opens dialog via `n` hotkey | no (separate `navigate`) | **yes** for dialog-back — but inconsistent with buttons. |

Bootstrap guard (`bootstrappedScopeRef` + `boardUrlParamsEqual`) correctly limits spurious navigations; the problem is **unified replace on user ephemeral keys**, not the equality guard.

---

## Out of scope (not re-reviewed)

Full backend, SV-11 chat/stage matrix, dialog template error path (covered in prior `dialog-final-review-composer.md`), `BoardDialogs` / `NavigationHotkeys` source beyond history interaction.

---

## Artifacts

| Artifact | Path |
| --- | --- |
| This report | `/tmp/syntaur-sv12/ui-polish-review-composer.md` |
| Browser matrix (ui-polish) | `/tmp/syntaur-sv12/ui-polish/browser-results.json` |
| Hermetic dialog history probe (not in dashboard vitest include) | `/tmp/syntaur-sv12/hermetic-dialog-history.test.tsx` |

**Reviewer:** Composer 2.5 (standard), read-only, worktree `codex/sv-12-dashboard`.
