# Fix 5 Dashboard Issues (Kanban Links, Markdown Comments, Stat Overflow, Filters, Duration)

**Date:** 2026-03-28
**Complexity:** small
**Tech Stack:** TypeScript, React 18, Vite 6, Tailwind CSS 3.4, react-router-dom 7, react-markdown 9, Express 5, better-sqlite3

## Objective
Fix 5 dashboard issues identified in the findings audit: a Kanban drag/click conflict, visible HTML comments in markdown, stat card overflow, missing filters on the Assignments page, and missing duration column on Agent Sessions.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `dashboard/src/components/KanbanBoard.tsx` | MODIFY | Fix `draggable` wrapper swallowing `<Link>` clicks |
| `dashboard/src/components/MarkdownRenderer.tsx` | MODIFY | Strip HTML comments before empty-state check |
| `dashboard/src/pages/Overview.tsx` | MODIFY | Fix stat card grid container for 6-7 cards |
| `dashboard/src/pages/AssignmentsPage.tsx` | MODIFY | Add status/priority/assignee/mission filter dropdowns; update empty-state copy |
| `dashboard/src/pages/AgentSessionsPage.tsx` | MODIFY | Add Duration column with live ticking |
| `dashboard/src/lib/format.ts` | MODIFY | Add `formatDuration` helper |
| `dashboard/src/types.ts` | MODIFY | Add optional `ended` field to `AgentSession` |
| `src/dashboard/types.ts` | MODIFY | Add optional `ended` field to backend `AgentSession` |
| `src/dashboard/agent-sessions.ts` | MODIFY | Include `ended` in `rowToSession` mapping |
| `src/__tests__/agent-sessions.test.ts` | MODIFY | Assert `ended` mapping; add `formatDuration` test |

## Tasks

### 1. Fix Kanban card link navigation (Bug)
- **File:** `dashboard/src/components/KanbanBoard.tsx` (MODIFY)
- **What:** The `draggable` attribute on the wrapper `<div>` at line 206-217 prevents child `<Link>` elements from navigating on click. The wrapper has `onDragStart`/`onDragEnd` handlers but no click handler -- the issue is the browser's `draggable` attribute intercepts click events on interactive children. Fix by tracking a `hasDragged` ref: set it to `true` in `handleDragStart` (line 81), reset it in `handleDragEnd`/`clearDragState` (line 76, 209). On the wrapper `<div>`, add an `onClickCapture` handler that calls `event.stopPropagation()` only if `hasDragged` is true (and then reset the ref). When no drag occurred, clicks pass through to the `<Link>` child. There is no existing click handler to modify -- this is purely additive.
- **Pattern:** The component already manages `draggedId` state (line 49). The ref is a lightweight addition alongside it.
- **Verify:** `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit` -- types compile. Manual: click assignment card title in Kanban view, confirm navigation. Drag still works. Also verify `MissionList.tsx` kanban view (line 250) still navigates correctly via `MissionBoardCard` `<Link>` at line 361, and `AssignmentsPage.tsx` list view (line 454) drag behavior is unaffected.

### 2. Strip HTML comments from Markdown preview (Bug)
- **File:** `dashboard/src/components/MarkdownRenderer.tsx` (MODIFY)
- **What:** Strip HTML comments from `content` BEFORE the `trim()`/empty-state check at line 15, not after it. Use the multiline-safe regex `/<!--[\s\S]*?-->/g` (not `<!--.*?-->` which fails on multi-line comments). The flow should be: (1) strip comments with regex, (2) check `if (!stripped.trim())` for empty state, (3) pass `stripped` to `<ReactMarkdown>` at line 25. This correctly handles the edge case where content is entirely HTML comments -- it shows the empty state instead of a blank render.
- **Pattern:** Follow the existing guard pattern at line 15. The sanitization step goes above it, replacing `content` usage with a `stripped` local variable.
- **Verify:** `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit`. Manual: open a mission/assignment whose markdown contains `<!-- TODO -->` -- comment is not visible. Test with a file that is only comments -- should show empty state.

### 3. Fix stat card grid overflow on Overview (UX)
- **File:** `dashboard/src/pages/Overview.tsx` (MODIFY)
- **What:** Change the grid container class at line 47 only. Currently `grid gap-3 md:grid-cols-2 xl:grid-cols-6` which breaks when the conditional 7th "Active Servers" card appears. Replace with a responsive approach using CSS grid `auto-fill`: `grid gap-3 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]`. Do NOT modify `StatCard.tsx` -- it has no `className` prop (line 20) and the fix belongs entirely on the container.
- **Pattern:** The `StatCard` component (`dashboard/src/components/StatCard.tsx`) renders its own `<article>` with fixed internal layout. Only the parent grid needs to change.
- **Verify:** Manual: resize the browser from narrow to wide. Confirm all stat cards (including "Stale" and conditional "Active Servers") are visible and wrap cleanly at all widths.

### 4. Add filter dropdowns to Assignments page (Improvement)
- **File:** `dashboard/src/pages/AssignmentsPage.tsx` (MODIFY)
- **What:** Add `useState` hooks for `statusFilter`, `priorityFilter`, `assigneeFilter`, and `missionFilter` (all defaulting to `'all'`). Derive unique values for each from `boardItems` using `useMemo`. For `assigneeFilter`, include an explicit `Unassigned` option since `assignee` is `string | null` (per `dashboard/src/hooks/useMissions.ts` line 43). For `missionFilter`, use `missionSlug` as the option value and `missionTitle` as the display label. Add `<select>` dropdowns inside the existing `<FilterBar>` (line 299-314) between `<SearchInput>` and `<ViewToggle>`. Extend the `filteredItems` `useMemo` (line 117-128) to apply all four filters alongside the search query. Also update the empty-state message at line 333-337: change "No assignments match this search" to "No assignments match these filters" and update the description to mention both search and filters.
- **Pattern:** Follow `dashboard/src/pages/MissionList.tsx` lines 101-144 exactly: `<select className="editor-input max-w-[180px]">` with an "All X" default option. Filter logic follows the same `useMemo` chain pattern at `MissionList.tsx` lines 29-55.
- **Verify:** `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit`. Manual: open Assignments page. Confirm dropdowns for status, priority, assignee, mission. Select a filter and verify list/table/kanban views update. Verify "Unassigned" option works for assignee. Clear filters and verify all items return.

### 5. Add duration/elapsed time to Agent Sessions (Feature)
This task spans backend types, backend mapping, frontend types, a utility function, the page component, and tests.

#### 5a. Add `ended` to backend types and mapping
- **File:** `src/dashboard/types.ts` (MODIFY)
- **What:** Add `ended?: string | null` (optional) to the `AgentSession` interface at line 357-365. Making it optional ensures existing producers in `src/dashboard/api-agent-sessions.ts` (line 66), `src/commands/track-session.ts` (line 49), and `src/dashboard/session-db.ts` (line 165) continue to work without modification -- they create `AgentSession` objects without `ended` and that's fine.
- **File:** `src/dashboard/agent-sessions.ts` (MODIFY)
- **What:** Add `ended: row.ended ?? null` to the `rowToSession` function at line 18-28. The DB `SessionRow` already has `ended: string | null` (line 13).
- **Verify:** `cd /Users/brennen/syntaur && npx tsc --noEmit` -- backend types compile without breaking existing producers.

#### 5b. Add `ended` to frontend types
- **File:** `dashboard/src/types.ts` (MODIFY)
- **What:** Add `ended?: string | null` (optional) to the `AgentSession` interface at line 47-55. Must be optional to match backend.
- **Verify:** `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit`

#### 5c. Add `formatDuration` utility
- **File:** `dashboard/src/lib/format.ts` (MODIFY)
- **What:** Add a `formatDuration(started: string, ended?: string | null)` function. If `ended` is null/undefined, compute elapsed from `started` to `Date.now()`. Return human-readable strings like "2h 14m", "45m", or "< 1m". Guard for invalid `started` input (return dash).
- **Pattern:** Follow the existing `formatDate`/`formatDateTime` style at lines 1-35: null guard, `new Date()` constructor, `isNaN` check, return string.
- **Verify:** `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit`

#### 5d. Add Duration column to AgentSessionsPage
- **File:** `dashboard/src/pages/AgentSessionsPage.tsx` (MODIFY)
- **What:** Add a "Duration" `<th>` to the table header at line 86 (between "Started" and "Status"). In `SessionRow` (line 106-146), add a `<td>` that calls `formatDuration(session.started, session.ended)`. For active sessions (`session.status === 'active'`), use a `useEffect` + `setInterval` (30s) to re-render the elapsed time so it ticks up live.
- **Pattern:** The table structure at lines 80-96 shows the header pattern. The `SessionRow` component at lines 106-146 shows the cell pattern.
- **Verify:** Manual: open Agent Sessions page. Active sessions show a ticking duration. Completed/stopped sessions show a fixed duration.

#### 5e. Add tests for `ended` mapping and `formatDuration`
- **File:** `src/__tests__/agent-sessions.test.ts` (MODIFY)
- **What:** In the `updateSessionStatus` describe block (line 72), add an assertion in the existing "updates status and returns true" test (line 73) that `all[0].ended` is defined after status change. Also add the `ended` field to the `makeSession` helper at line 23 (set to `undefined` to match the optional type). Add a new test file or test block for `formatDuration` to verify: active session (no `ended`) returns a live string, completed session returns "2h 14m" for a known interval, edge case `< 1m`.
- **Pattern:** Follow the existing test structure with `describe`/`it`/`expect` from vitest.
- **Verify:** `cd /Users/brennen/syntaur && npm test`

## Dependencies
- No new packages needed. All dependencies are already installed.

## Verification
- `cd /Users/brennen/syntaur && npm run typecheck` -- backend types clean
- `cd /Users/brennen/syntaur/dashboard && npm run build` -- frontend build passes (runs `tsc -b && vite build` per `dashboard/package.json` line 8)
- `cd /Users/brennen/syntaur && npm test` -- all tests pass
- Manual: open dashboard, verify all 5 issues are resolved per individual task verification steps
- Regression: verify MissionList kanban view (`dashboard/src/pages/MissionList.tsx` line 250) card links still navigate correctly after KanbanBoard changes
