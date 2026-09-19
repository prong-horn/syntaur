# SV-12 final independent acceptance — Composer 2.5

**Date:** 2026-09-19  
**Reviewer:** Cursor Composer 2.5 (standard; not fast)  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Plan:** `Codex-info/plans/SV-12-dashboard-six-pages.md` (Revision 3)  
**Scope:** Final closure only — history-fix medium, supersession of prior QA/review gaps, gate re-probe, two plan-specific browser gaps (draft return, history-close focus). Not a full re-review of Sol-accepted foundation.

**NODE_OPTIONS:** unset for all probes below.

---

## Overall verdict

| Result | High | Medium | Low (residual / accepted) |
| --- | ---: | ---: | ---: |
| **CHANGES_REQUIRED** | **0** | **1** | **4** |

**Actionable blocker:** Plan Task 3 requires new-ticket → new-project → **return** with draft title/body intact. Browser **history back** after `dialog=new-project` preserves draft (PASS). **New-project form “Back”** closes the board dialog entirely and drops draft (FAIL). Production code swaps dialogs via `setDialog` with no lifted ticket draft (`BoardDialogs.tsx`); explicit return is not implemented.

Root must not mark SV-12 Task 7 **READY** until new-project exit returns to `dialog=new-ticket` with preserved draft (or an approved plan amendment).

---

## History-fix independent code review (medium closure)

**Supersedes:** `ui-polish-review-composer.md` **CHANGES_REQUIRED** (medium: dialog back/forward via Board UI).

| Intent | `replace` | Code | Assessment |
| --- | --- | --- | --- |
| Bootstrap / prefs normalization | yes | `useBoardFilters` `updateUrl(..., 'bootstrap' \| 'preference-sync')` | Correct — avoids extra stack entry after legacy redirect. |
| Open `dialog` / `panel` | no (push) | `'open-ephemeral'` on `setDialog` / `setPanel` | Matches plan §57 user-initiated ephemeral opens. |
| Close `dialog` / `panel` | yes | `'close-ephemeral'` | Avoids duplicate stack on close. |
| Hash on navigate | preserved | `navigate({ pathname, search, hash: location.hash })` | Confirmed with route review. |
| History back/forward without prefs write | — | `useBoardFilters.route.test.tsx` “does not persist prefs…” | PASS — no spurious pref writes on popstate. |
| Focus when `dialog` clears via URL | — | `BoardDialogs.tsx` `useEffect` on `state.dialog` transition | Complements `DialogShell` `onOpenChange` (history path). |

**Unit contract:** `boardUrlNavigation.test.ts` + extended `useBoardFilters.route.test.tsx` (dialog back/forward, legacy inbox back, hash) — **13/13** in focused run (this session).

**Browser (history-fix harness, port 54852):** `history-fix-composer-handoff.md` — legacy back, dialog open/back/forward with filters + `#hist` — all **PASS** (`history-fix/browser-results.json`).

**Disposition:** Prior ui-polish **medium #1** → **CLOSED** with meaningful mounted + Playwright proof. Documented **low** tradeoff: filter/sort/view tweaks remain `preference-sync` + `replace` (no filter undo stack); handoff + history-fix handoff accept; not plan-required.

---

## Prior failed / missing matrix — superseding evidence

| Prior finding | Source | Superseding evidence | Status |
| --- | --- | --- | --- |
| Legacy back lands on board not inbox | `qa-composer-report.md` FAIL | `history-fix` + `ui-polish` browser PASS; `useBoardFilters.route.test.tsx` inbox back | **Closed** |
| Narrow ticket overflow 390px | qa-composer FAIL | `ui-polish/browser-results.json` PASS; layout fixes in ContentTabs/TicketHeader/TicketPage | **Closed** |
| Board dialog history back (medium) | `ui-polish-review-composer.md` | History-fix intents + tests + `history-fix/browser-results.json` | **Closed** |
| SV-11 stage-dispatch browser rows BLOCKED | qa-composer | `qa-stage-composer-report.md` 7/7 PASS | **Closed** |
| Snooze / sessions pagination / Library CRUD BLOCKED or FAIL | qa-composer | `qa-data-crud-composer-report.md` 20/20 PASS | **Closed** |
| No-project validation only | qa-data-crud (note) | This closure: back-return draft PASS; **Back-button return FAIL** (see medium) | **Partial** |
| History-close focus (no browser row) | dialog-final low / history-fix handoff | `final-closure/focus-browser-result.json` **PASS** (port 54861) | **Closed** |
| qa-composer BLOCKED overall | qa-composer | Superseded per-row above; full matrix not re-run (orchestration) | **N/A** |

---

## Final-closure browser (this session)

**Harness:** `/tmp/syntaur-sv12/final-closure` (artifacts under `final-closure/artifacts/`; asserted `asserted-*.txt`; no port 4800; no live `~/.syntaur`).

| Case | Result | Notes |
| --- | --- | --- |
| `board-new-ticket-new-project-return-draft` | **PASS** | No active projects; edit title → “Create a project first” → `dialog=new-project` → **browser back** → `dialog=new-ticket` with marker `SV12-DRAFT-PRESERVE-COMPOSER-CLOSURE`. |
| `board-new-ticket-new-project-cancel-return` | **FAIL** | Same fixture; new-project **Back** → `/board` without dialog; draft lost. Matches code: `onClose` → `setDialog(null)`. |
| `board-dialog-history-close-focus` | **PASS** | Open via TopBar “New Ticket” link → history back → focus on New ticket control (`focus-browser-result.json`). |

Artifacts: `final-closure/browser-results.json`, `cancel-draft-result.json`, `focus-browser-result.json`, `screenshots/history-close-focus.png`.

**Limitation:** Draft PASS uses **history back**, not in-product “return” after new-project **Back**. No unit test for draft preservation; browser-only.

---

## Gates (this session; root full suite not re-run)

Backend unchanged since `integration-sol-handoff.md` (root **2996** pass / **2** documented skips). Re-probed closure-relevant gates only:

| Gate | Exit | When / evidence |
| --- | ---: | --- |
| `npm run lint:dashboard` | 0 | This session |
| `npm run typecheck` | 0 | This session |
| `npx tsc -p tsconfig.tests.json --noEmit` | 0 | This session |
| `npx vitest run src/__tests__/dashboard-architecture.test.ts` | 0 | This session (negative fixture tree) |
| Focused `npm run test:dashboard` (boardUrlNavigation, useBoardFilters.route, LegacyRedirect) | 0 | **13** tests, this session |
| `npm run build --prefix dashboard` | 0 | This session (before final-closure server) |
| `npm test` (full root) | — | **Not rerun** (orchestration: no backend change since Sol handoff) |
| `npm run test:dashboard` (full **468**) | — | Cited `history-fix-composer-handoff.md` post-fix; not duplicated here |

Publish workflow / `lint:dashboard` in CI: per `integration-sol-handoff.md` + architecture script present in tree.

---

## Finding disposition (remaining)

### Medium — new-project exit must return ticket draft (plan Task 3)

**Requirement:** “If none exist, offer new-project creation and **return** with the draft title/body intact.”

**Evidence:** `verify-cancel-draft.mjs` → **FAIL** (`cancel-draft-result.json`). **Browser back** roundtrip **PASS** does not satisfy explicit UI return; `NewProjectDialog` `onCancel={onClose}` clears `dialog` (`BoardDialogs.tsx` ~93–110, ~169).

**Required fix direction (review only):** Lift pending ticket draft to `BoardDialogs` (or stack `dialog` transitions) so new-project **Back** / successful create returns to `dialog=new-ticket` with same markdown; add mounted or browser test.

### Low — accepted / non-blocking

1. **Filter history undo** — `replace` on preference-sync; documented tradeoff; not Revision 3 requirement.  
2. **Dialog focus on Cancel/save** — `setDialog(null)` bypasses `DialogShell` restore; prior dialog-final acceptance.  
3. **Workspace-prefix hash** — residual; route-review + ui-polish hardening; narrow URL family.  
4. **Draft preservation test gap** — no vitest; history-back browser only; explicit Back path fails.

---

## Slice readiness (orchestration map)

| Slice | Ready? | Notes |
| --- | --- | --- |
| Sol integration / six pages / data layer | Yes | `integration-sol-handoff.md`; not re-litigated |
| Route / hash / projectVisibility | Yes | `route-review-composer.md` |
| Dialog M2 (template error, hotkey guard) | Yes | `dialog-final-review-composer.md` |
| UI polish (legacy back, narrow ticket, workspace hash) | Yes | Handoff + browser; history-fix refines dialog semantics |
| History-fix (dialog back/forward + focus via history) | Yes | Handoff + this review |
| Browser QA matrix (scoped gaps) | Yes | qa-stage + qa-data-crud + superseded qa-composer rows |
| **Plan new-ticket ↔ new-project draft return (UI)** | **No** | **Medium blocker above** |

---

## Residual limitations (honest)

- Full SV-12 browser matrix and root **2996** test run not repeated in this closure pass.  
- Final-closure Playwright scripts run from `history-fix/node_modules` (no `package.json` in `final-closure/`); results valid, harness ergonomics only.  
- Focus browser case used TopBar **New Ticket** link; project-panel button path covered in `history-fix/verify-history-fix.mjs` (not re-run this session after server churn).  
- Paid ACP / port 4800 / live home not used.

---

## Artifacts index

| Document | Path |
| --- | --- |
| This verdict | `/tmp/syntaur-sv12/final-closure-composer.md` |
| History-fix handoff | `/tmp/syntaur-sv12/history-fix-composer-handoff.md` |
| Final-closure browser | `/tmp/syntaur-sv12/final-closure/browser-results.json` |
| Focus probe | `/tmp/syntaur-sv12/final-closure/focus-browser-result.json` |
| Cancel/back draft probe | `/tmp/syntaur-sv12/final-closure/cancel-draft-result.json` |

**Reviewer:** Composer 2.5 independent closure for root orchestration.
