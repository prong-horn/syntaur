# Dashboard Sidebar Nav Groups

**Date:** 2026-06-17
**Complexity:** small
**Tech Stack:** React 18 + TS, Vite 6, React Router 7, Tailwind, lucide-react (dashboard SPA)

## Objective
Reorganize the flat 11-item global sidebar nav into pinned items (Overview, Needs me) plus three labeled, collapsible groups (Library, Board, Operations). Persist both the new group collapse state and the existing (currently in-memory) workspace collapse state to localStorage, with no route changes and identical behavior in the desktop sidebar and the mobile overlay.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `dashboard/src/hooks/useSidebarCollapse.ts` | CREATE | localStorage-backed, string-keyed collapse hook + pure testable storage helpers |
| `dashboard/src/hooks/__tests__/useSidebarCollapse.test.ts` | CREATE | Unit test for the pure storage helpers (see Dependencies caveat) |
| `dashboard/src/components/SidebarNav.tsx` | MODIFY | Add an optional collapsible group-header render path with `aria-expanded` |
| `dashboard/src/components/AppShell.tsx` | MODIFY | Define grouped nav data; wire group + workspace collapse to the new hook |

## Tasks

### 1. Create `useSidebarCollapse` hook with pure, node-testable storage helpers
- **File:** `dashboard/src/hooks/useSidebarCollapse.ts` (CREATE)
- **What:** Mirror the structure of `dashboard/src/hooks/useTodoSectionCollapse.ts` but key the collapse map by plain `string` (group id like `library`/`board`/`operations` and workspace keys like `ws:<name>`) instead of `TodoSectionId`. Keep the SSR/quota-safe `readStore()` / `writeStore()` guards and read-modify-write `toggle`. Use storage key `syntaur.sidebar.collapsed.v1`. Expose the same `{ isCollapsed, toggle }` API; `isCollapsed(id, defaultCollapsed?)` should accept an optional per-id default (groups default expanded = `false`).
- **Critical:** Export the pure storage primitives separately so they can be unit-tested in a node environment without React/jsdom — e.g. `readCollapse(raw: string | null): Record<string, boolean>` and `toggleCollapse(map, id): Record<string, boolean>` as plain functions the hook composes. This matches how `dashboard/src/hooks/__tests__/wsManager.test.ts` tests exported module functions rather than the React hook itself (no `renderHook`, no `@testing-library/react` exists).
- **Pattern:** `dashboard/src/hooks/useTodoSectionCollapse.ts` for the hook/store shape; `dashboard/src/hooks/wsManager.ts` for module-level pure-function exports.
- **Verify:** `npm run build --prefix dashboard` typechecks the hook.

### 2. Add a collapsible group-header render path to `SidebarNav`
- **File:** `dashboard/src/components/SidebarNav.tsx` (MODIFY)
- **What:** Keep the existing flat-list behavior unchanged for pinned items and the utility zone. Add an optional way to render a labeled, collapsible group: a header `<button type="button">` with `aria-expanded={!collapsed}`, a `ChevronDown` that rotates (`-rotate-90` when collapsed), the group label, and the existing item list rendered only when expanded. The simplest approach is a small new exported component (e.g. `SidebarNavGroup`) in this same file that reuses the existing item-rendering markup (active styling `bg-foreground text-background shadow-sm` vs `text-muted-foreground hover:bg-background/80 hover:text-foreground`, badge pill, `onNavigate` threading, and the `isSidebarItemActive(...) && !location.pathname.startsWith('/w/')` guard at line 26-27). Do not change `item.to: SidebarSection` typing or `routes.ts`.
- **Pattern:** Header affordance from `dashboard/src/components/TodoAccordionSection.tsx` lines 43-59 (`aria-expanded`, rotating `ChevronDown`); item row markup from current `SidebarNav` lines 30-55.
- **Verify:** `npm run build --prefix dashboard`.

### 3. Define grouped nav data structure in `AppShell`
- **File:** `dashboard/src/components/AppShell.tsx` (MODIFY)
- **What:** Replace the flat `GLOBAL_NAV_ITEMS` (lines 42-54) with two constants: `PINNED_NAV_ITEMS` = [Overview `/`, Needs me `/inbox`] and `GLOBAL_NAV_GROUPS` = an array of `{ id, label, items }` for `Library` (Playbooks, Memories, Resources), `Board` (Todos, Saved Views `/views`, Archive), `Operations` (Inventories, Schedules, Usage). Reuse the existing `SidebarNavItem` icons already imported at line 4. All 11 destinations and their `to` values stay identical (no route changes).
- **Pattern:** Existing `GLOBAL_NAV_ITEMS` / `UTILITY_NAV_ITEMS` const shape.
- **Verify:** Confirm all 11 `to` values from the old list appear exactly once across the new pinned + group structure.

### 4. Wire group collapse and migrate workspace collapse to the persisted hook
- **File:** `dashboard/src/components/AppShell.tsx` (MODIFY, inside `ShellSidebar`)
- **What:**
  - Instantiate `useSidebarCollapse()` once in `ShellSidebar`.
  - Render the global zone (currently line 276 `<SidebarNav items={globalNavItems} .../>`) as: pinned `<SidebarNav items={pinnedNavItems} onNavigate={onNavigate} />` (inject the inbox badge here exactly as lines 151-153 do today — keep `{ ...item, badge: inboxTotal }` on the `/inbox` item) followed by one collapsible group per `GLOBAL_NAV_GROUPS` entry, each driven by `isCollapsed(group.id)` / `toggle(group.id)`.
  - Replace the in-memory workspace collapse: remove the `useState<Set<string>>` at line 159 and the local `toggleCollapse` at lines 169-179; derive `isCollapsed` for a workspace from the same hook using a namespaced key (e.g. `ws:${ws}`) and call `toggle(\`ws:${ws}\`)` from the header button at line 331. The existing header markup at lines 328-340 (ChevronDown rotation at 338, `{!isCollapsed && <nav>}` at 357) stays; only its state source changes.
- **Pattern:** `useTodoSectionCollapse` call sites for `{ isCollapsed, toggle }` usage; existing workspace header at AppShell lines 328-357.
- **Verify:** `npm run build --prefix dashboard`; manual reload check that group + workspace collapse states persist.

### 5. Verify desktop + mobile parity and build
- **File:** (no new file) verification only
- **What:** Both the desktop `<aside>` (AppShell ~line 96) and the mobile overlay (~lines 115-118) render the same `ShellSidebar`, so grouped nav and localStorage-backed collapse appear identically in both with no extra work. Sanity-check this by reading the render once more after edits.
- **Verify:** `npm run build --prefix dashboard` passes; load dashboard, toggle groups/workspaces, reload, confirm persistence; open mobile hamburger overlay and confirm grouped nav renders.

## Dependencies
- No new packages. All icons + `ChevronDown` already imported in `AppShell.tsx` line 4.
- **Testing caveat (important):** The dashboard `__tests__` directories are NOT wired into any test runner. The root `vitest.config.ts` has `include: ['src/__tests__/**/*.test.ts']` and `environment: 'node'`, which excludes everything under `dashboard/`; `npx vitest run dashboard/src/...` reports "No test files found". There is also no `@testing-library/react` or jsdom installed, so a `renderHook`-style test cannot run. Therefore: (a) write the Task 1 test against the pure exported storage helpers (node-safe, mock `window.localStorage`), matching the colocated `wsManager.test.ts` convention so it is ready if a dashboard runner is added; (b) treat the authoritative gate as `npm run build --prefix dashboard`, not a green test run. Do not claim the hook test executes in CI.

## Verification
- `npm run build --prefix dashboard` — must pass (this is the real gate; root `npm run typecheck` excludes `dashboard/`).
- (Best-effort, currently non-executing) hook test: `npx vitest run dashboard/src/hooks/__tests__/useSidebarCollapse.test.ts` — note this will report "No test files found" under the current root config; the test is colocated for future wiring, not CI-enforced today.
- Manual: reload persists group + workspace collapse; all 11 destinations reachable; active highlighting intact on grouped items; inbox badge present on pinned "Needs me"; mobile overlay shows grouped nav.
