# SV-12 UI polish — Composer 2.5 handoff

**Worktree:** `/Users/brennen/syntaur/.worktrees/codex/sv-12-dashboard`  
**Harness:** `/tmp/syntaur-sv12/ui-polish` (artifacts symlinked to `qa-composer/artifacts`; server port **54851**; stopped after verify)  
**Hermetic paths:** `HOME` / `SYNTAUR_HOME` / `defaultProjectDir` under `/tmp/syntaur-sv12/ui-polish/artifacts` (asserted `asserted-*.txt`); `NODE_OPTIONS` unset.

## Diagnosis

### Legacy back after replace redirect (confirmed)

**Repro (matches qa-composer):** `/inbox` → `/tickets?status=review#x` → browser back landed on board, not inbox.

**Root cause:** `LegacyRedirect` correctly uses `replace` (legacy URL must not remain on the stack). After redirect, `useBoardFilters` `updateUrl` called `navigate()` **without** `replace`, pushing a second board entry when prefs/defaults serialized into the query string. Back skipped inbox and returned to the intermediate board URL.

**Disposition:** Fixed — board URL sync uses `replace: true` so preference/bootstrap normalization does not add history entries. Legacy `replace` unchanged.

### `/w/:workspace/...` hash (confirmed low, route-review)

**Risk:** String `Navigate to={`${path}${search}${hash}`}` can drop fragments on the workspace strip hop.

**Disposition:** Fixed — `WorkspacePrefixRedirect` moved to `LegacyRedirect.tsx`, uses `legacyDestinationToLocation()` object `to` (same as primary legacy redirect).

### Narrow ticket overflow at 390px (confirmed)

**Repro:** `document.documentElement.scrollWidth > innerWidth` on `/t/QA-1`.

**Root cause:** `ContentTabs` tab strip (`overflow-x-auto`) expanded layout width (~569px) because ancestors lacked `min-w-0` / `max-w-full` containment; tab triggers were not `shrink-0`. Ticket header action row also benefited from wrap-on-narrow (`max-lg:order-last`).

**Disposition:** Fixed — `ContentTabs.tsx` width containment + `TicketHeader.tsx` responsive wrap; `TicketPage` `min-w-0` on shell/grid.

## Code changes (exact)

| File | Change |
| --- | --- |
| `dashboard/src/hooks/useBoardFilters.ts` | `updateUrl` → `navigate(..., { replace: true })` |
| `dashboard/src/components/LegacyRedirect.tsx` | Export `WorkspacePrefixRedirect` with hash-safe object navigation |
| `dashboard/src/App.tsx` | Import `WorkspacePrefixRedirect` from `LegacyRedirect` |
| `dashboard/src/components/ContentTabs.tsx` | `min-w-0` / `max-w-full` / `overflow-hidden` on tab chrome; `shrink-0` triggers |
| `dashboard/src/components/ticket/TicketHeader.tsx` | `flex-wrap`; full-width wrapping action row below `lg` |
| `dashboard/src/pages/TicketPage.tsx` | `min-w-0` on page root and tab grid |
| `dashboard/src/components/__tests__/LegacyRedirect.test.tsx` | Workspace prefix + hash mounted test |
| `dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx` | Inbox → legacy tickets → history back → inbox |

**Not touched:** `BoardDialogs`, `NavigationHotkeys` (per scope).

## Evidence

### Unit (focused)

```text
npm run test:dashboard -- --run \
  dashboard/src/components/__tests__/LegacyRedirect.test.tsx \
  dashboard/src/hooks/__tests__/useBoardFilters.route.test.tsx
→ 9/9 passed
```

### Browser (`/tmp/syntaur-sv12/ui-polish/verify-ui-polish.mjs`, port 54851, after `npm run build --prefix dashboard`)

| Case | Result |
| --- | --- |
| `legacy-back-forward` | **PASS** — back URL `http://127.0.0.1:54851/inbox` |
| `workspace-legacy-hash` | **PASS** — `/w/ws-1/tickets?status=review#x` → board with `#x` |
| `narrow-ticket-overflow` | **PASS** — `horizontalOverflow=false` |

Artifacts: `ui-polish/browser-results.json`, `ui-polish/screenshots/{legacy-back-forward,workspace-legacy-hash,narrow-ticket-390}.png`.

### Build

`npm run build --prefix dashboard` — success (pre-browser).

## Notes for orchestration

- qa-composer **FAIL** rows for legacy back and narrow ticket should be re-run on this tree to close the two **[L]** findings; full matrix not repeated here.
- Board filter URL updates are now uniformly `replace`; user-driven filter changes no longer create per-tweak history entries (acceptable tradeoff for correct back-from-legacy; aligns with URL as current state, not a filter undo stack).
