# SV-12 draft-return fix — Composer 2.5 handoff

**Date:** 2026-09-19  
**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Scope:** BoardDialogs new-ticket ↔ new-project draft continuity (medium closure from `final-closure-composer.md`).  
**NODE_OPTIONS:** unset for all commands below.

## Fix summary

Lifted pending new-ticket draft and explicit `newProjectReturnToTicket` flow intent in `BoardDialogs.tsx` so:

- **New-ticket → new-project → Back** returns to `dialog=new-ticket` with the same title/body snapshot (no `localStorage`, no URL body encoding).
- **Successful project create** from that hop returns to `dialog=new-ticket` with draft intact and the new project pre-selected (including a synthetic option when the projects list has not refetched yet).
- **Standalone** `dialog=new-project` keeps prior close behavior (Back / cancel clears the board dialog and does not reopen new-ticket).

Supporting change: optional `onContentChange` on `MarkdownEditor` so ticket body edits are captured before the new-project hop.

## Hermetic harness (`/tmp/syntaur-sv12/draft-return`)

| Asserted | Path |
| --- | --- |
| `HOME` | `/tmp/syntaur-sv12/draft-return/artifacts/home` (`artifacts/asserted-home.txt`) |
| `SYNTAUR_HOME` | `/tmp/syntaur-sv12/draft-return/artifacts/syntaur-home` (`artifacts/asserted-syntaur-home.txt`) |
| `config.defaultProjectDir` | `/tmp/syntaur-sv12/draft-return/artifacts/projects` (`artifacts/asserted-project-dir.txt`, `syntaur-home/config.md`) |

No live `~/.syntaur`, port **4800**, or paid ACP. Dashboard served on **54870** for browser proof.

## Browser evidence (Playwright)

**Script:** `/tmp/syntaur-sv12/draft-return/verify-draft-return.mjs`  
**Results:** `/tmp/syntaur-sv12/draft-return/browser-results.json`  
**Exit code:** `0`

| Case | Status |
| --- | --- |
| `board-new-ticket-new-project-back-return-draft` | **PASS** |
| `board-new-ticket-new-project-create-return-draft` | **PASS** |
| `board-standalone-new-project-back-closes` | **PASS** |

## Mounted / unit evidence

| Command | Exit | Notes |
| --- | ---: | --- |
| `npx vitest run src/components/board/__tests__/BoardDialogs.mounted.test.tsx` (dashboard cwd) | **0** | 4/4 incl. draft return, leakage, standalone close |
| Focused regressions (`boardUrlNavigation`, `useBoardFilters.route`, `BoardDialogs.mounted`, `LegacyRedirect`) | **0** | 17/17 |
| `npm run test:dashboard` | **0** | **471** passed |
| `npm run typecheck` | **0** | root |
| `npm run build --prefix dashboard` | **0** | after fix |

**Not rerun:** full root `npm test` (2996) — no backend change in this slice.

## Files touched (production)

- `dashboard/src/components/board/BoardDialogs.tsx` — lifted draft + return intent
- `dashboard/src/components/MarkdownEditor.tsx` — `onContentChange`
- `dashboard/src/components/board/__tests__/BoardDialogs.mounted.test.tsx` — regression tests

## Servers

Task-owned dashboard on 54870 **stopped** after browser run (`server.pid` killed). No lingering harness processes from this task.

## Residual / orchestration

- Plan Task 3 medium (**UI return with draft**) is **addressed** for Back, successful create, and no-project fallback; history back/forward semantics unchanged (still URL-driven via `useBoardFilters`).
- Root may re-run `final-closure` cancel-draft probe; expected **PASS** with this tree.
