# SV-12 Task 6 integration handoff — GPT-5.6 Sol

Worktree: `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard` (`codex/sv-12-dashboard`, stacked on SV-11). No commit/reset/merge/push, live HOME/config/port 4800, or paid ACP operation. All family edits were preserved. Accepted base is `7fcac54c`; all subsequent work is uncommitted and awaits independent review/QA.

## Integrated product

- Canonical production pages are exactly `NeedsMePage`, `BoardPage`, `TicketPage`, `SessionsPage`, `LibraryPage`, `SettingsPage` (physical LOC: 298, 251, 436, 186, 57, 125 respectively). `App.tsx` routes only these page families; `legacyRoutes.ts` provides replace redirects with query/hash retention. Fixed conflicting project query identity in project redirects. Legacy ticket plan/notes edit links now resolve the current manifest role and path in `TicketPage` and disclose unavailable editors in Journal; overflow actions use role-derived paths rather than assumed `plan.md`/`scratchpad.md`.
- `AppShell`, `TopBar`, `SidebarNav`, Settings and Search dialog are wired. Search/new-ticket are visible. Agent-picker and session-row links now target canonical routes. Navigation hotkeys are only `g n`, `g b`, `g s`, `g l`, `g ,`, `n`; a g chord expires after 1 second, and editable, IME, modifier, repeat, and dialog state suppress it. Mobile navigation is labelled as a dialog for the guard. Custom binding/palette UI and its frontend hook/alias were removed. Historical config block remains tolerated by existing backend config handling.
- Family resources share `useResource`/mutation plumbing. ThemeProvider uses `useThemeConfig`, which subscribes to config resource invalidations. Architecture checker enforces six page modules/<=500 LOC and rejects raw fetch in production UI with AST fixtures; root test and publish workflow run it. Publish workflow installs both lockfile dependencies and runs the scoped backend-test type probe.
- Removed unused Help API model/source, Overview API function/helpers/copy/types, old page modules and obsolete UI components; retained live project/board/read-only archive APIs and stale-candidate collector. Reworked root overview/cache/performance tests around staying `listProjects`/`listTicketsBoard` readers, preserving the synthetic 60x30 warm benchmark. README and CLI docs describe six pages, Board history/archive, lifetime metric semantics, search, and fixed hotkeys.
- Added meaningful role-based editor and redirect collision tests; updated stale resource invalidation expectations and removed obsolete palette/help tests. No production raw `fetch` outside `data/client.ts` or explicitly stateful chat/dispatch adapters per architecture checker.

## Final gates (real exits, NODE_OPTIONS unset)

| Gate | Exit | Evidence |
| --- | ---: | --- |
| `npm run typecheck` | 0 | last run after backend cleanup |
| `npx tsc -p tsconfig.tests.json --noEmit` | 0 | last run after backend cleanup |
| `npm run lint:dashboard` | 0 | part of final root `npm test`; six-page/AST checker passed |
| `npm test -- --reporter=dot` | 0 | `/tmp/syntaur-sv12/root-test-sol-cleanup-rerun.log`: 2,996 passed, 2 expected skips |
| `npm run test:dashboard` | 0 | `/tmp/syntaur-sv12/dashboard-test-sol-green.log`: 452 passed |
| `npm run build` | 0 | `/tmp/syntaur-sv12/backend-build-sol-cleanup.log` |
| `npm run build --prefix dashboard` | 0 | `/tmp/syntaur-sv12/dashboard-build-sol-cleanup.log` |
| `git diff --check` | 0 | final check |

Expected root skips: `perf-overview.test.ts` is gated by `SYNTAUR_PERF_BENCH=1`; `lock-coord-child.test.ts` runs only with its child-operation env. An earlier full root run after backend cleanup failed once on `search-config.test.ts` with `UND_ERR_SOCKET` under full parallel load; that file passed alone (13/13, `/tmp/syntaur-sv12/search-config-sol.log`) and the entire root suite subsequently passed. Earlier stale-test and UI-type failures were fixed, not suppressed. Dashboard build emits only the existing large-chunk advisory.

## Remaining acceptance work

Independent code review and isolated browser QA are still required. Use fresh `/tmp/syntaur-sv12/...` fixture HOME, SYNTAUR_HOME and config.defaultProjectDir; assert all three before starting the server, use fake ACP, and avoid port 4800. Exercise the browser matrix in the plan, especially back/forward dialog behavior/focus, old plan/notes links with custom manifest paths, archived empty project restore, live resource coalescing, metric labels, and hotkeys within inputs/dialogs. No browser screenshots or request counts are claimed here. Root owns Syntaur ticket/plan records and review acceptance.
