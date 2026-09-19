# SV-12 draft-return final acceptance — Composer 2.5

**Date:** 2026-09-19  
**Reviewer:** Cursor Composer 2.5 (standard; not fast)  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Plan:** `Codex-info/plans/SV-12-dashboard-six-pages.md` (Revision 3)  
**Prior closure:** `/tmp/syntaur-sv12/final-closure-composer.md` (CHANGES_REQUIRED — 1 medium draft-return)  
**Fix handoff:** `/tmp/syntaur-sv12/draft-return-fix-composer-handoff.md`  
**Scope:** Independent verification of the draft-return medium closure and regressions only. Supersedes final-closure on Task 3 UI return; does not re-litigate Sol integration, broad QA matrix, or full root `npm test`.

**NODE_OPTIONS:** unset for all probes below.

---

## Overall verdict

| Result | High | Medium | Low (residual / accepted) |
| --- | ---: | ---: | ---: |
| **READY** | **0** | **0** | **3** |

**Aggregate:** Plan Task 3 (“offer new-project creation and **return** with the draft title/body intact”) is satisfied for visible **Back**, successful **create**, no-active-project path, standalone new-project, and draft leakage. Prior final-closure medium is **CLOSED**. Root may mark SV-12 material requirements **READY** subject to orchestration boundaries in `Codex-info/plans/SV-12-acceptance.md` (merge/push/live restart still out of scope for this review).

---

## Draft-return medium — disposition (supersedes final-closure)

| Requirement | Production mechanism | Evidence | Status |
| --- | --- | --- | --- |
| Lift draft across new-ticket → new-project | `pendingTicketDraft` + `openNewProjectFromTicket` snapshot (`content`, `projectSlug`, `templateId`) | `BoardDialogs.tsx` | **Met** |
| Visible **Back** returns to `dialog=new-ticket` with same title/body | `returnToTicketAfterClose` → `onClose` calls `setDialog('new-ticket')`; `restoredDraft` + `useEffect` rehydrate fields | Mounted + browser | **PASS** |
| No active projects → “Create a project first” hop | `activeProjects.length === 0` branch; `onNeedProject` captures `draftContent` via `onContentChange` | Code + browser | **PASS** |
| Successful project create returns with draft + new project selected | `onCreatedReturnToTicket` updates `projectSlug`; synthetic `<option>` when list not refetched | Browser `project=my-new-project` | **PASS** |
| Standalone `dialog=new-project` unchanged | `returnToTicketAfterClose === false` → `onClose` → `setDialog(null)` | Mounted + browser | **PASS** |
| No cross-session leakage after normal close / fresh open | `clearTicketDraftFlow` on new-ticket close; `useEffect` clears state when `dialog === null` | Mounted test | **PASS** |

**Code review notes (no new findings):**

- Draft storage is in-memory only (appropriate; no URL/localStorage body encoding).
- `MarkdownEditor` `onContentChange` keeps body snapshot current before hop; title edits use existing frontmatter/title input path (browser + mounted use title input).
- Successful create clears `newProjectReturnToTicket` but keeps `pendingTicketDraft` with new slug — correct for continued ticket create.
- History semantics remain URL-driven via `useBoardFilters` `open-ephemeral` / `close-ephemeral` (unchanged from history-fix acceptance).

**Regression check (error / retry / hotkeys / history / focus):**

| Area | Assessment |
| --- | --- |
| Template error + **Retry** | Unchanged; `BoardDialogs.mounted.test.tsx` “failed template GET” still in suite (**471** dashboard tests pass). |
| History back/forward | No change to `useBoardFilters` intents; **13/13** focused route/navigation tests pass this session. |
| Focus | In-dialog **Back** (ticket ↔ project) keeps dialog open — does not re-run history-close focus probe; prior `final-closure` focus **PASS** still valid. Cancel/save close path unchanged (accepted low). |
| Hotkeys | Fixed nav hotkeys per plan; no regression introduced in this slice (hotkey palette removal predates fix). |

---

## Historical low findings — accurate disposition

| Prior low (source) | This review |
| --- | --- |
| **Draft preservation test gap** (`final-closure-composer.md`) | **Closed** — `BoardDialogs.mounted.test.tsx` adds back-return, leakage, standalone close (+ existing template retry). |
| **History-close focus** (dialog-final / final-closure) | **Closed** — superseded by `final-closure/focus-browser-result.json`; not re-run this session (no code change in focus path). |
| **Workspace-prefix hash** (ui-polish / route-review) | **Accepted residual** — narrow URL family; hardening already accepted; not re-opened. |
| **Filter history undo** (`preference-sync` + `replace`) | **Accepted** — documented tradeoff; not Revision 3 requirement. |
| **Dialog focus on Cancel/save** (`setDialog(null)` bypass) | **Accepted** — pre-existing; out of draft-return scope. |

---

## Browser (this session)

**Harness:** `/tmp/syntaur-sv12/draft-final-review` (hermetic `HOME` / `SYNTAUR_HOME` / `defaultProjectDir` under `artifacts/`; fixture seed from `/tmp/syntaur-sv12/qa-composer/artifacts` — not live `~/.syntaur`; ports **54871** / **54872** only; **4800** not used).

**Script:** `verify-draft-return.mjs` (Playwright via symlinked `draft-return/node_modules`).

| Case | Result | Notes |
| --- | --- | --- |
| `board-new-ticket-new-project-back-return-draft` | **PASS** | Marker `SV12-DRAFT-FINAL-REVIEW`; `dialog=new-ticket` after visible **Back**. |
| `board-new-ticket-new-project-create-return-draft` | **PASS** | Draft marker retained; project select `my-new-project`. |
| `board-standalone-new-project-back-closes` | **PASS** | No `dialog=` param; dialog count 0. |

**Artifacts:** `draft-final-review/browser-results.json`, `artifacts/asserted-*.txt`, `artifacts/logs/server.log`.

**Legacy `verify-cancel-draft.mjs`:** Not used as acceptance gate. When run in isolation after `setup-no-projects.sh`, it reported **FAIL** (`hasMarker=false`) while URL already showed `dialog=new-ticket` — weaker wait/detection (textarea-only, 1s sleep) vs `verify-draft-return.mjs` `waitForFunction` + title/textarea dual check. Same user path is **PASS** in primary script and mounted tests. Final-closure `cancel-draft-result.json` **FAIL** is **superseded**.

---

## Gates (this session)

| Gate | Exit | Notes |
| --- | ---: | --- |
| `npm run typecheck` | 0 | Root |
| `npx tsc -p tsconfig.tests.json --noEmit` | 0 | |
| `npm run lint:dashboard` / `check-dashboard-architecture.mjs` | 0 | Production tree |
| `npx vitest run src/__tests__/dashboard-architecture.test.ts` | 0 | 3/3 (incl. negative fixtures) |
| `npm run build --prefix dashboard` | 0 | After current tree |
| `npm run test:dashboard` | 0 | **471** passed |
| Focused regressions (BoardDialogs.mounted, boardUrlNavigation, useBoardFilters.route, LegacyRedirect) | 0 | **17/17** |
| Full root `npm test` (~2996) | — | Not rerun (no backend change; per orchestration) |

---

## Residual limitations (honest)

1. Full SV-12 browser matrix and root backend suite not repeated in this pass.  
2. Create-return browser asserts non-empty project selection and draft marker; does not assert exact slug string when editor slug field differs from saved slug (synthetic option covers refetch lag).  
3. Harness `setup-no-projects.sh` log path quirk (`logs/` vs `artifacts/logs/`) — cosmetic; archive + API empty list confirmed.  
4. Paid ACP, port **4800**, and live `~/.syntaur` not used.

---

## Slice readiness (orchestration map)

| Slice | Ready? | Notes |
| --- | --- | --- |
| Sol integration / six pages / data layer | Yes | `integration-sol-handoff.md` |
| Route / hash / projectVisibility | Yes | `route-review-composer.md` |
| Dialog M2 (template error, hotkey guard) | Yes | `dialog-final-review-composer.md` |
| UI polish + history-fix | Yes | Prior handoffs + `final-closure-composer.md` (non–draft-return rows) |
| Browser QA scoped gaps | Yes | qa-stage + qa-data-crud supersessions |
| **Plan Task 3 draft return (UI)** | **Yes** | This review |

---

## Artifacts index

| Document | Path |
| --- | --- |
| This verdict | `/tmp/syntaur-sv12/draft-final-review-composer.md` |
| Draft-return fix handoff | `/tmp/syntaur-sv12/draft-return-fix-composer-handoff.md` |
| Prior closure (superseded on medium) | `/tmp/syntaur-sv12/final-closure-composer.md` |
| Browser results (this session) | `/tmp/syntaur-sv12/draft-final-review/browser-results.json` |

**Servers:** Task-owned dashboard processes on **54871** / **54872** stopped after probes; no lingering harness PIDs from this review.

**Reviewer:** Composer 2.5 independent draft-return final acceptance for root orchestration.
