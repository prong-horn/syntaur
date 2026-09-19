# SV-12 dialog final review — Composer 2.5 (independent)

**Date:** 2026-09-19  
**Reviewer:** Cursor Composer 2.5 (standard; not fast)  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Inputs:** repo `AGENTS.md`, `Codex-info/plans/SV-12-dashboard-six-pages.md` (Revision 3), `/tmp/syntaur-sv12/final-review-sol.md`, `resume-review-composer.md`, `dialog-regressions-composer-handoff.md`  
**Scope:** BoardDialogs focus/shell lifecycle, M2 automated proof, happy-dom mounted tests, NavigationHotkeys guard (verify only; no re-litigation of accepted a11y/hotkey design). **Out of scope:** root code review, routes/BoardFilter/archive URL slice (`route-review-composer.md`), live HOME/port 4800/browser QA matrix, commits/edits.

**NODE_OPTIONS:** unset for probes below.

---

## Verdict

| Overall | CHANGES_REQUIRED | Residual (non-blocking) |
|---------|------------------|-------------------------|
| **READY** (dialog-fix / M2 slice) | **high=0, medium=0, low=0** | **low=4** (verification debt only) |

Prior `resume-review-composer.md` **CHANGES_REQUIRED** on Sol medium #2 (missing template error-path test) is **closed** by `BoardDialogs.mounted.test.tsx`. No new medium/high defects found in changed dialog scope.

---

## Sol finding disposition (unchanged acceptance for #1 and #3; #2 closed on proof)

| # | Severity | Sol topic | Disposition | Evidence |
|---|----------|-----------|-------------|----------|
| 1 | medium | Shortcut guard bypass | **READY** (reconfirmed) | `isOpenDialogPresent()` queries `[role="dialog"], [role="alertdialog"], [aria-modal="true"]` (`NavigationHotkeys.tsx:24-30`); early return before chords (`50-56`). Board flows use Radix `DialogContent` (`BoardDialogs.tsx` `DialogShell`). Mounted proof: `NavigationHotkeys.boardDialog.test.tsx` — `[role="dialog"]` present; `n` and `g`+`b` from Close with `navigateMock` not called; after close, `g b` → `/board`, `n` → `/board?dialog=new-ticket`. |
| 2 | medium | Template error trapped in loading | **READY** (M2 closed) | Branch order: `if (error)` before `loading \|\| draftContent === null` (`BoardDialogs.tsx:242-245`). Mounted: `GET /api/templates/ticket` 503 → body contains `Something went wrong`, not `Loading ticket template` → Retry click → second GET 200 → `Select project` + `textarea` (`BoardDialogs.mounted.test.tsx:81-106`). URL matches `boardResources.ticketTemplate()` (`/api/templates/ticket`), not Sol’s illustrative `/api/ticket-template`. |
| 3 | low | Dialog a11y / focus | **READY** (prior acceptance stands) | `DialogTitle` / `DialogDescription` + `aria-describedby="board-dialog-description"` (`BoardDialogs.tsx:334-336`); Close `aria-label` (`337-340`); edit-project uses same `DialogShell` (`58-81`). No re-review of Radix trap defaults beyond confirming no regression to custom unnamed overlay. |

---

## Production implementation (BoardDialogs)

| Concern | Assessment | Evidence |
|---------|------------|----------|
| Single shell / no remount on load→error→form | **Sound** | `NewTicketDialog` / `NewProjectDialog` compute `body` then one `DialogShell` return (`241-301`, `141-173`). Loading/error/form swap children inside same `Dialog` instance. |
| Controlled Radix lifecycle | **Sound** | `DialogShell`: `open` state + `onOpenChange` sets `open`, restores focus, then `onCloseRef.current()` (`318-331`). `DialogClose asChild` on Close button (`337-340`). |
| Focus restore on Close | **Implemented** | `restore?.focus({ preventScroll: true })` in `onOpenChange` when `!next` (`328-329`). |
| `restoreFocusRef` test hook | **Does not mask production path** | Optional prop (`29-35`); `BoardPage` does **not** pass it (grep: no matches in `BoardPage.tsx`). Production uses `internalRestoreFocusRef` captured when `state.dialog` transitions null→open (`40-54`). Integration test sets override on opener click (`NavigationHotkeys.boardDialog.test.tsx:66-80`) to stabilize happy-dom; asserts `DialogShell` restore path via `focus` spy (`134-141`), not internal capture. |
| Programmatic close (Cancel / save) | **Gap (low)** | `onCancel={onClose}` / `onSaved` call `actions.setDialog(null)` directly (`74`, `133`, `233`, `289`) — unmounts without `onOpenChange(false)`, so explicit `restoreFocusRef` restore does not run on those paths. Sol low already accepted with Radix primitive; Close-button path is what M2 tests. |
| Render-phase focus capture | **Acceptable risk (low)** | Capture during render when dialog opens (`42-48`); URL/hotkey-only open may record `body` (handoff §4). Not introduced by test override. |

`NewProjectDialog` still uses loading-then-error order (`142-150`); consistent with `useResource` settling `loading: false` on failure — not the ticket bug pattern (error while `draftContent === null`).

---

## Test realism and dependencies

| Artifact | Realism | Notes |
|----------|---------|-------|
| `BoardDialogs.mounted.test.tsx` | **High for M2** | Real `ResourceProvider`, `ResourceStore`, `createFakeFetch`, `MemoryRouter`, `StrictMode`, full `BoardDialogs` + `Harness` state updates. Not a shallow component mock. |
| `NavigationHotkeys.boardDialog.test.tsx` | **High for guard + Close** | Co-mounted `NavigationHotkeys` + `BoardDialogs` + Radix portal (`createDomTestRoot` appends to `document.body`). Proves real `querySelector` guard, not mock object. |
| `NavigationHotkeys.test.tsx` | **Unchanged mock** | Still valid unit guard for predicate wiring; supplemented, not replaced. |
| `domTestRoot.tsx` / `boardDialogTestHelpers.ts` | **Appropriate** | Portal-friendly `createRoot`; minimal board state with `dialog: 'new-ticket'`. |
| `happy-dom@^20.0.2` | **Scoped** | Root `package.json` devDependency; per-file `// @vitest-environment happy-dom` on mounted dialog tests only. |

**Test limitations (low, documented):**

1. After close, test calls `opener().focus()` before chord assertions because happy-dom `document.activeElement` is unreliable after programmatic `focus()` (`NavigationHotkeys.boardDialog.test.tsx:143-145`; handoff §1).
2. No mounted cases for **new-project**, **edit-project**, template **loading**-only UI, **Cancel** close, or **history back** — outside Sol’s explicit M2 bar but listed as residual verification.
3. stderr: Radix `Description` / `aria-describedby` warnings during loading transition in mounted run (non-failing; handoff §2).

**`restoreFocusRef` does not hide a production bug:** production never passes it; failure of internal capture would not be caught by the mounted hotkey test, but that is residual low debt, not a false pass on the template-error or hotkey-guard defects.

---

## Focused probes (this session)

```text
unset NODE_OPTIONS
npx vitest run -c vitest.dashboard.config.ts \
  dashboard/src/components/board/__tests__/BoardDialogs.mounted.test.tsx \
  dashboard/src/components/navigation/__tests__/NavigationHotkeys.boardDialog.test.tsx \
  dashboard/src/components/navigation/__tests__/NavigationHotkeys.test.tsx
→ exit 0 — 3 files, 3 tests passed (~784ms)
```

Integrator-reported gates (462 dashboard tests, typecheck, build) not re-run here per instruction; handoff aligns with focused pass above.

---

## Workspace-prefix hash (narrow, from `route-review-composer.md`)

**Classification: low, out of dialog slice; not blocking M2.**

`WorkspacePrefixRedirect` builds a string `Navigate` target including `location.hash` (`App.tsx:13-17`). Primary legacy paths use object navigation via `LegacyRedirect` / `useBoardFilters.updateUrl` (documented in `route-review-composer.md`). Residual risk is first-hop `/w/:workspace/...#fragment` only; no change required for dialog acceptance.

---

## M2 integrator checklist

| Item | Status |
|------|--------|
| Template error before loading + Retry + refetch | **PASS** (code + mounted test) |
| `n` / `g b` blocked with real Board Radix dialog | **PASS** (mounted test) |
| Focus restore on Close | **PASS** (`focus` spy); browser `activeElement` optional |
| Luna QA matrix row | **Not claimed** (parallel browser QA) |

---

## Residual low (non-blocking)

1. Internal `internalRestoreFocusRef` capture untested without `restoreFocusRef` override.  
2. Cancel / success unmount paths skip explicit focus restore in `DialogShell`.  
3. Additional dialog variants and history-back not mounted.  
4. Workspace-prefix hash hop (route family; see above).

---

## Artifacts

- This report: `/tmp/syntaur-sv12/dialog-final-review-composer.md`
- Prior closure: `/tmp/syntaur-sv12/resume-review-composer.md` (superseded on medium #2 only)
