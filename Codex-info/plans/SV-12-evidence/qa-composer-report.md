# SV-12 Composer browser QA report

Date: 2026-09-19  
Worktree: `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
Harness: `/tmp/syntaur-sv12/qa-composer`  
Server: port `54814`; `HOME` / `SYNTAUR_HOME` / `config.defaultProjectDir` under `/tmp/syntaur-sv12/qa-composer/artifacts` (see `artifacts/asserted-*.txt`); `NODE_OPTIONS` unset; no port 4800; fake ACP via `artifacts/bin/claude-agent-acp` → `fake-claude-agent-acp.mjs` (no paid models).

**Result: BLOCKED** for full SV-12 browser acceptance. Desktop and narrow navigation, Board core flows, Luna dialog hotkey guard, legacy hash retention, fake ACP chat send, shared GET dedupe, and WS burst coalescing are demonstrated with Playwright. Remaining BLOCKED matrix rows need SV-11 stage-dispatch fixtures; several FAIL rows need product or fixture follow-up.

Supplements Luna desktop evidence (`/tmp/syntaur-sv12/qa-luna-report.md`) with Playwright narrow viewport, request counts, fake ACP, and post–dialog-fix Board dialog tests. Sol partial nav harness (`/tmp/syntaur-sv12/qa-sol/browser-results.json`) superseded for acceptance purposes by this run.

## Hermetic assertions (pre-server)

| Variable | Path |
| --- | --- |
| `HOME` | `/tmp/syntaur-sv12/qa-composer/artifacts/home` |
| `SYNTAUR_HOME` | `/tmp/syntaur-sv12/qa-composer/artifacts/syntaur-home` |
| `config.defaultProjectDir` | `/tmp/syntaur-sv12/qa-composer/artifacts/projects` |

## Matrix

| Case | Result | Evidence |
| --- | --- | --- |
| Six navigation destinations, desktop | **PASS** | `/inbox`, `/board`, `/t/QA-1`, `/sessions`, `/library/playbooks`, `/settings`; screenshots `screenshots/nav-desktop-*.png`; per-page GET counts in `browser-results.json` (e.g. inbox shell: inbox/projects/theme/agents each ×1). |
| Six destinations, narrow (390px) | **PASS** | Same routes; `screenshots/nav-narrow-*.png`; no horizontal overflow on five of six (see narrow ticket row). |
| Legacy routes query + hash | **PASS** | `/tickets?status=review#x` → `/board?...#x`; `/projects/qa-atlas?tab=archive#keep` → `/board?...#keep`. Luna M-finding **not reproduced** on current tree (archive/route fix worker handoff may apply). `legacy-tickets-hash.png`, `legacy-project-hash.png`. |
| Legacy back after redirect | **FAIL** | After `inbox` → `/tickets?status=review#x`, `history.back()` landed on `/board?...#x`, not `/inbox`. SPA `replace` redirect may not leave a back stack entry. |
| Board kanban/table/filter/query/history | **PASS** | 5 kanban cards, 5 table rows; `history=all` shows “All history”; AQL input updates URL. `board-filters.png`. |
| Board new-ticket dialog + hotkey guard | **PASS** | `/board?dialog=new-ticket`; `n` did not dismiss dialog (Luna/Radix dialog fix). `board-new-ticket-dialog-hotkey.png`. |
| Board edit-project dialog | **PASS** | `/board?dialog=edit-project&project=qa-atlas`; Radix dialog present; Escape closes. |
| Board archive/restore (incl. CLI archive) | **PASS** | `syntaur archive qa-atlas`; archived panel + Restore; restore clicked. `board-archive-restore.png`. |
| Board archived empty visibility | **PASS** | `/board?panel=projects&projectVisibility=archived` labels “Archived projects” (Luna first-load mismatch **not reproduced** this run). `board-archived-empty.png`. |
| Ticket/header metrics known (QA-1) | **PASS** | Seeded usage `$0.50` visible on ticket and board card. `metrics-QA-1.png`. API: `costUsd: 0.5`, `costSource: usage`. |
| Ticket/header metrics unknown (QA-2) | **PASS** | “Cost unknown” / em dash copy; no dollar amount. `metrics-QA-2.png`. |
| Visible search deep link | **PASS** | Search dialog → “Known metric” → `/t/QA-1`. `search-deeplink.png`. |
| Journal append | **PASS** | Journal tab append UI. `journal-live.png`. |
| Journal external refresh (no reload) | **PASS** (corrected) | Initial matrix used wrong JSON field (`text` vs `body`); retest with `{ type, body }` showed entry within 2.5s without reload. |
| Needs me question visible | **PASS** | Question row rendered when fixture present (run 2). `inbox-question.png`. |
| Needs me answer | **PASS** | Answer submitted in browser during run 2. |
| Needs me snooze | **FAIL** | After answer, inbox empty (`total: 0`); snooze control not re-exercised. Fixture gap, not waived. |
| Fake ACP chat send | **PASS** | `@qa-fake` message → “Fake ACP OK for QA.” `chat-fake-acp.png`. Agent: `agents/qa-fake.md`, harness stub on PATH. |
| Fake ACP handoff / receipt retry / stable request IDs / one-use Start | **BLOCKED** | No scripted stage-dispatch ticket states in harness; plan points to focused SV-11 vitest + future fixture ticket. |
| Sessions usage filter independence | **PASS** | URL retained `usageWindow=30d` with `page=1` and `panel=usage` (`sessions-usage-independence`). Earlier `sessions-usage-filter` case used flawed sequential navigation (FAIL; superseded). |
| Sessions pagination with rows | **BLOCKED** | No `track-session` rows seeded; list empty-state only. |
| Library templates readonly | **PASS** | Five built-in templates; editing unavailable. |
| Library playbooks nav | **PASS** | List → detail. `library-playbook-detail.png`. |
| Library fake agent test API | **PASS** | `POST /api/chat/agents/qa-fake/test` → `ok: true`, reply from fake adapter. |
| Library agents/playbooks create/edit/rename UI | **BLOCKED** | CRUD/rename browser flows not completed; test API only. |
| Hotkeys `g n` + Settings shortcuts/README | **PASS** | `g`+`n` → `/inbox`; Settings lists six chords + doc link. `settings.png`. |
| Shared resource GET (page + shell) | **PASS** | Inbox load: `/api/inbox?maxAgeDays=14` ×1, `/api/config/theme` ×1 (`transport-shared-get-inbox`). |
| DB/WS burst coalescing | **PASS** | Append to `project.md` triggered coalesced refresh: 1× `/api/tickets`, 1× `/api/projects`, 1× `/api/archived`, 1× `/api/inbox` (`transport-ws-burst-coalesce`, `ws-burst.png`). |
| Narrow ticket horizontal overflow | **FAIL** | `/t/QA-1` at 390px: `scrollWidth > innerWidth` (Sol harness also flagged 390/t/QA-1). |

## Findings (actionable)

### [L] Ticket detail horizontal overflow at 390px width

**Repro:** Playwright viewport 390×850, `/t/QA-1`. `document.documentElement.scrollWidth > innerWidth`.  
**Artifact:** `narrow-ticket-overflow` in `browser-results.json`; compare `qa-sol` 390/t/QA-1 screenshot.

### [L] Legacy back navigation after replace redirect

**Repro:** `inbox` → `/tickets?status=review#x` → browser back. Does not return to `/inbox`.  
**Note:** May be expected with `replace` redirects; plan asked for back/forward behavior—document as UX gap if intentional.

## Resolved vs Luna / Sol review (this run only)

| Prior item | Composer run |
| --- | --- |
| Luna [M] legacy hash dropped | **PASS** (hashes preserved) |
| Luna [M] archived panel wrong facet on first load | **PASS** on empty archived panel |
| Sol [M] Board dialog hotkey bypass | **PASS** with `dialog=new-ticket` + `n` |
| Sol independent review dialog/a11y | Dialog fix **exercised** in browser; full a11y audit not claimed |

Defer final acceptance on route/archive paths until **archivefix worker** handoff confirms intended hash/back behavior.

## Gate evidence

Integration gates cited from [`integration-sol-handoff.md`](/tmp/syntaur-sv12/integration-sol-handoff.md); **not rerun** (QA-only pass). Dialog fix unit evidence: [`dialog-fixes-luna.md`](/tmp/syntaur-sv12/dialog-fixes-luna.md).

## Artifacts

| Path | Description |
| --- | --- |
| `/tmp/syntaur-sv12/qa-composer/browser-results.json` | 45 case records with statuses, URLs, GET counts |
| `/tmp/syntaur-sv12/qa-composer/screenshots/` | Playwright PNGs per case |
| `/tmp/syntaur-sv12/qa-composer/browser-matrix.mjs` | Primary matrix runner |
| `/tmp/syntaur-sv12/qa-composer/browser-supplement.mjs` | Archive/restore, snooze retry, usage independence, overflow |
| `/tmp/syntaur-sv12/qa-composer/setup-fixtures.sh` | Synthetic project/tickets/agents |
| `/tmp/syntaur-sv12/qa-composer/logs/` | CLI fixture logs |

## Counts

| Severity | Count |
| --- | ---: |
| High | 0 |
| Medium | 0 |
| Low | 2 |

Matrix: **PASS** 33 (incl. corrected journal refresh) · **FAIL** 4 · **BLOCKED** 5 (JSON also lists superseded FAIL rows from harness bugs).

**READY:** No — BLOCKED SV-11 stateful flows, Library CRUD UI, sessions pagination, and snooze re-fixture remain. Root should await archivefix handoff and schedule handoff/dispatch fixture work.
