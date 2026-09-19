# SV-12 data-CRUD browser QA (Composer)

Date: 2026-09-19  
Worktree: `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
Harness: `/tmp/syntaur-sv12/qa-data-crud`  
Server: port **54825** (stopped after run); `HOME` / `SYNTAUR_HOME` / `config.defaultProjectDir` under harness `artifacts/`; `NODE_OPTIONS` unset; no port 4800; fake ACP via `artifacts/bin/claude-agent-acp` → `qa-composer/fake-claude-agent-acp.mjs`.

**Scope:** Remaining data-CRUD browser cases from `qa-composer-report.md` only. Templates readonly **not** re-run (already PASS). No production/repo edits.

**Result: PASS** — all scoped CRUD cases exercised with Playwright UI, API checks, and screenshots.

## Hermetic assertions (pre-server)

| Variable | Path |
| --- | --- |
| `HOME` | `/tmp/syntaur-sv12/qa-data-crud/artifacts/home` |
| `SYNTAUR_HOME` | `/tmp/syntaur-sv12/qa-data-crud/artifacts/syntaur-home` |
| `config.defaultProjectDir` | `/tmp/syntaur-sv12/qa-data-crud/artifacts/projects` |

Evidence: `artifacts/asserted-home.txt`, `asserted-syntaur-home.txt`, `asserted-project-dir.txt`.

## Fixtures

- `setup-fixtures.sh` — project `qa-atlas`, tickets, inbox question on QA-3, `qa-fake` agent, archived empty project `qa-empty-archive`.
- `seed-sessions.sh` — 55× `track-session --session-id qa-crud-sess-NNN` for pagination/filters.
- Inbox question reseeded with clean journal before snooze flow.

## Matrix

| Case | Result | Evidence |
| --- | --- | --- |
| Needs me: open question visible | **PASS** | `screenshots/needsme-question-visible.png` |
| Needs me: snooze **before** answer | **PASS** | `Not now` → `One day`; API `total=0`, `snoozedCount=1`; `needsme-after-snooze.png` |
| Needs me: unsnooze | **PASS** | `Snoozed (1)` foot → `Unsnooze`; `needsme-after-unsnooze.png` |
| Needs me: answer + verify cleared | **PASS** | `Reply inline…` + `Answer`; inbox API `total=0`; `needsme-after-answer.png` |
| Sessions pagination (rows) | **PASS** | `sessionPage=0` → `sessionPage=1`, 50 rows/page, 55 total; `sessions-page-1-retry.png` |
| Sessions usage vs session URL independence | **PASS** | `usageWindow=30d` + `panel=usage` with `sessionPage=1`; `sessions-usage-independence.png` |
| Sessions search filter | **PASS** | `search=Synthetic CRUD session 55`; `sessions-search-filter.png` |
| Library playbook create | **PASS** | Structured **Playbook name** + slug fields (raw-only template hits `my-playbook` duplicate); `library-playbook-created-retry2.png` |
| Library playbook edit | **PASS** | `CRUD edit marker` in body |
| Library playbook rename | **PASS** | `crud-pb-mu8hdieg-renamed`; `library-playbook-renamed-retry2.png` |
| Library playbook detail | **PASS** | Detail after rename |
| Library agent create (validation error) | **PASS** | Save with empty id; `library-agent-validation-error.png` |
| Library agent create + edit | **PASS** | `qa-crud-agent-8h8rz3`; name edit persisted |
| Library agent Test (fake ACP) | **PASS** | UI: `OK in 0.1 s · model fake-model`; `library-agent-test-retry.png` |
| Library agent test API error path | **PASS** | `POST …/does-not-exist-qa/test` → 404 |
| Board archived **empty** project restore | **PASS** | `Empty Archive QA` restore; `board-archived-empty-restore.png` |
| Board new **project** submit | **PASS** | Dialog save → project panel; `board-new-project-created.png` |
| Board new **ticket** submit | **PASS** | `QA-5-crud-board-ticket-ui` in API + disk; dialog used Ticket title + slug fields |
| Board new ticket no-project fallback | **PASS** | `Select a project before creating a ticket.`; `board-new-ticket-no-project-retry.png` |

## Notes (non-blocking)

1. **Inbox snooze UI** uses **Not now** / **One day** (not “Snooze” / “1 day” from earlier harness).
2. **Session URL** uses `sessionPage` / `sessionPageSize`, not `page`.
3. **Board new ticket** after save may navigate to filtered board rather than `/t/<id>` even when creation succeeds (ticket present in API and `artifacts/projects/.../QA-5-crud-board-ticket-ui`).
4. **Playbook create** via raw markdown alone can fail on default `my-playbook` slug; structured editor fields are required for reliable CRUD.

## Defects filed

None blocking this CRUD scope. No production changes made.

## Artifacts

| Path | Description |
| --- | --- |
| `/tmp/syntaur-sv12/qa-data-crud/browser-results.json` | 20 case records |
| `/tmp/syntaur-sv12/qa-data-crud/browser-crud-matrix.mjs` | Primary runner |
| `/tmp/syntaur-sv12/qa-data-crud/browser-crud-supplement.mjs` | Retries / pagination URL fix |
| `/tmp/syntaur-sv12/qa-data-crud/screenshots/` | PNG evidence |
| `/tmp/syntaur-sv12/qa-data-crud/artifacts/logs/` | CLI fixture + track-session logs |

## Counts

| Outcome | Count |
| --- | ---: |
| PASS | 20 |
| FAIL | 0 |
| BLOCKED | 0 |

**READY for CRUD slice:** Yes — prior `qa-composer-report.md` BLOCKED/FAIL rows in this scope are addressed with synthetic fixtures and UI proof.
