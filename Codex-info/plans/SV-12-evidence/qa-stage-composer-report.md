# SV-12 stage-dispatch browser QA — Composer 2.5 (qa-stage)

**Date:** 2026-09-19  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Harness:** `/tmp/syntaur-sv12/qa-stage` (isolated; no production edits)  
**Server:** port `54816` (stopped after run); `HOME` / `SYNTAUR_HOME` / `defaultProjectDir` under `/tmp/syntaur-sv12/qa-stage/artifacts` (`asserted-*.txt`); `NODE_OPTIONS` unset; no port 4800; fake ACP via `artifacts/bin/claude-agent-acp` → `fake-claude-agent-acp.mjs` (not paid/live adapter).

**Result:** **PASS** — SV-11 stateful stage-dispatch matrix rows exercised in browser with network IDs, screenshots, and recorded request IDs. Supplements `/tmp/syntaur-sv12/qa-composer-report.md` (those rows were **BLOCKED**).

## Hermetic assertions (pre-server)

| Variable | Path |
| --- | --- |
| `HOME` | `/tmp/syntaur-sv12/qa-stage/artifacts/home` |
| `SYNTAUR_HOME` | `/tmp/syntaur-sv12/qa-stage/artifacts/syntaur-home` |
| `config.defaultProjectDir` | `/tmp/syntaur-sv12/qa-stage/artifacts/projects` |

Synthetic templates: `qa-handoff` (manual `in_progress` dispatch), `qa-auto` (`auto: true`). Agents: `qa-fake`, `qa-alt`. Fixture IDs in `fixture-ids.txt` (e.g. `QS-8` auto-fresh); `setup-fixtures.sh` resets backlog tickets before each run.

## Matrix (SV-11 → SV-12 preserved)

| Case | Result | Evidence |
| --- | --- | --- |
| Fake ACP handoff **complete** (normal path) | **PASS** | `Hand to @qa-fake` → turn completed; fake adapter text in chat path; `requestId=e1ef39de-2273-4de5-a38a-f46969213f7f` in `browser-stage-results.json`; screenshot `handoff-complete.png`. |
| Handoff **unknown** + **stable request ID** retry | **PASS** | Intercepted malformed `200` POST → UI unknown/retry; **2** dispatch POSTs with **same** `requestId=89faf873-adcf-4667-a986-479b8579e541`; receipt GET polls until `completed`; `handoff-unknown-stable-id.png`. |
| **Stale entry** retry messaging | **PASS** | First dispatch POST fulfilled `409 stale or unknown stage entry`; stale copy in UI; `handoff-stale-entry.png`. |
| **Automatic** handoff / recorded target | **PASS** | After Start on `autoFresh` ticket: API `stageHandoff.auto=true`, `recordedTargetId=qa-fake`; UI shows handoff to `@qa-fake` / running or completed; `handoff-automatic-ui.png`. |
| Start **untouched** (no `agent` in body) | **PASS** | `POST /api/tickets/.../verbs/start` body `{}`; `start-untouched.png`. |
| Start **one-use** explicit recipient | **PASS** | Picker `@qa-alt` → `POST` body `{"agent":"qa-alt"}`; `start-explicit-override.png`. |
| Fake ACP chat (backend integration) | **PASS** | `@qa-fake` chat reply visible; `chat-fake-acp-stage.png`. |

## Notes

- **Unknown / timeout paths** use Playwright route interception (documented in `browser-stage-matrix.mjs`); **complete** and **chat** paths use real dashboard broker + fake ACP stub on `PATH`.
- **Not claimed:** live paid ACP, port 4800, or live `~/.syntaur` data.
- Re-run: `setup-fixtures.sh` then `run-dashboard.sh 54816` then `node browser-stage-matrix.mjs`.

## Artifacts

| Path | Description |
| --- | --- |
| `/tmp/syntaur-sv12/qa-stage/browser-stage-results.json` | 7 case records with requestIds / descriptor snapshots |
| `/tmp/syntaur-sv12/qa-stage/screenshots/` | PNG evidence per case |
| `/tmp/syntaur-sv12/qa-stage/browser-stage-matrix.mjs` | Focused stage matrix runner |
| `/tmp/syntaur-sv12/qa-stage/setup-fixtures.sh` | Synthetic project/tickets/agents + backlog reset |

## Counts

| Status | Count |
| --- | ---: |
| PASS | 7 |
| FAIL | 0 |
| BLOCKED | 0 |

**Stage-dispatch browser matrix:** **READY** for handoff to root acceptance (remaining gaps in qa-composer report: Library CRUD UI, sessions pagination, snooze, legacy back, narrow overflow — out of qa-stage scope).
