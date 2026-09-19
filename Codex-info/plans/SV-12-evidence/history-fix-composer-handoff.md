# SV-12 Board dialog history — Composer 2.5 handoff

**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Harness:** `/tmp/syntaur-sv12/history-fix` (port **54852**; server PID in `server.pid` — stop with `kill $(cat server.pid)` when done)  
**Hermetic paths:** `HOME` / `SYNTAUR_HOME` / `defaultProjectDir` under `/tmp/syntaur-sv12/history-fix/artifacts` (`asserted-*.txt`); `NODE_OPTIONS` unset; port 4800 not used; no live home config or paid ACP.

## Medium regression (resolved)

**Symptom:** Global `updateUrl` → `navigate(..., { replace: true })` made Board UI `setDialog` / `setPanel` replace the current history entry. Browser Back left the Board instead of closing `dialog=` while keeping filters (plan Revision 3 §57).

**Fix:** `dashboard/src/lib/boardUrlNavigation.ts` — intent-based history:

| Intent | `replace` | Used for |
| --- | --- | --- |
| `bootstrap` | yes | Post-prefs `useEffect` URL normalization (legacy stack safe) |
| `preference-sync` | yes | Filter/sort/view user edits (handoff tradeoff) |
| `open-ephemeral` | no (push) | `setDialog` / `setPanel` open |
| `close-ephemeral` | yes | `setDialog` / `setPanel` close (no extra stack entry) |

**Focus:** `BoardDialogs.tsx` — `useEffect` restores opener focus when `dialog` clears via history (not only via `DialogShell` `onOpenChange`).

**Not reverted:** Narrow ticket containment, workspace/hash `LegacyRedirect`, legacy inbox-back `replace` after redirect.

## Code touched

| File | Change |
| --- | --- |
| `dashboard/src/lib/boardUrlNavigation.ts` | New navigation intent helpers |
| `dashboard/src/lib/__tests__/boardUrlNavigation.test.ts` | Unit contract |
| `dashboard/src/hooks/useBoardFilters.ts` | Intent on `updateUrl`; bootstrap vs ephemeral |
| `dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx` | Dialog back/forward + no persist on history |
| `dashboard/src/components/board/BoardDialogs.tsx` | History-driven focus restore |

## Gates (actual)

### Focused unit

```text
unset NODE_OPTIONS
npm run test:dashboard -- --run \
  dashboard/src/lib/__tests__/boardUrlNavigation.test.ts \
  dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx \
  dashboard/src/components/__tests__/LegacyRedirect.test.tsx
→ 13/13 passed
```

### Dashboard build

```text
npm run build --prefix dashboard
→ exit 0
```

### Full dashboard suite

```text
unset NODE_OPTIONS && npm run test:dashboard
→ 64 files, 468/468 passed, exit 0
```

### Browser (Playwright, synthetic harness)

```text
/tmp/syntaur-sv12/history-fix/prepare.sh
/tmp/syntaur-sv12/history-fix/setup-fixtures.sh
npm run build && npm run build --prefix dashboard
/tmp/syntaur-sv12/history-fix/run-dashboard.sh 54852
cd /tmp/syntaur-sv12/history-fix && HISTORY_FIX_PORT=54852 node verify-history-fix.mjs
```

| Case | Result |
| --- | --- |
| `legacy-back-forward` | **PASS** — back URL `/inbox` |
| `board-dialog-open` | **PASS** — `dialog=new-ticket`, `status=review`, `#hist` |
| `board-dialog-history-back` | **PASS** — dialog omitted, filters + hash retained |
| `board-dialog-history-forward` | **PASS** — dialog reopened |

Artifacts: `/tmp/syntaur-sv12/history-fix/browser-results.json`, `screenshots/*.png`.

## Review disposition

| Severity | Count | Notes |
| --- | ---: | --- |
| high | 0 | |
| medium | 0 | Dialog back/forward via Board **New ticket** button closed in browser + mounted tests |
| low | 1 | Filter tweaks still `replace` (documented tradeoff; not plan-required undo stack) |

**Reviewer follow-up:** Re-run qa-composer **[L]** rows only if orchestration requires; full matrix not repeated here.
