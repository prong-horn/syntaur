# Drag-Drop and Inline Status Updates for List and Table Views

**Date:** 2026-03-26
**Complexity:** small
**Tech Stack:** TypeScript, React 18, Tailwind CSS, native HTML5 drag-drop, Lucide icons

## Objective
Add drag-drop status changes to the list view and an inline status dropdown to the table view so all three assignment views support status transitions, not just kanban.

## Files
| File | Action | Purpose |
|------|--------|---------|
| `dashboard/src/pages/AssignmentsPage.tsx` | MODIFY | Add drag-drop to list view, inline status dropdown to table view |
| `dashboard/src/components/StatusBadge.tsx` | MODIFY | Export `STATUS_META` so the dropdown can reuse labels/colors |

## Tasks

### 1. Export STATUS_META from StatusBadge
- **File:** `dashboard/src/components/StatusBadge.tsx` (MODIFY)
- **What:** Add `export` to the existing `STATUS_META` const (line 12) so the assignments page can import it for dropdown option labels and styling.
- **Verify:** `npx tsc --noEmit` passes; no other consumers break.

### 2. Add drag state to AssignmentsPage
- **File:** `dashboard/src/pages/AssignmentsPage.tsx` (MODIFY)
- **What:** Add `draggedId` and `dropTargetStatus` state variables (both `string | null`) alongside the existing `transitioningId` state at lines 106-108. Add `DragEvent` to the React import on line 1.
- **Verify:** TypeScript compiles.

### 3. Wire drag-drop into the list view
- **File:** `dashboard/src/pages/AssignmentsPage.tsx` (MODIFY)
- **What:** In the list view branch (lines 334-371):
  - Make each `AssignmentBoardCard` wrapper `draggable` with `onDragStart` (set `draggedId` and `dataTransfer`), `onDragEnd` (clear state). Follow the exact pattern from `KanbanBoard.tsx` lines 81-89 and 206-209.
  - Make each status group header `<button>` (line 342) also serve as a drop zone: add `onDragOver` (preventDefault if valid, set `dropTargetStatus`) and `onDrop` (call `handleMove` with `toColumnId: status`, clear drag state). Validate with `getAssignmentAction` the same way kanban's `canDrop` does (lines 379-395).
  - Add visual feedback classes: the dragged card gets `scale-[0.98] opacity-50` and `cursor-grab active:cursor-grabbing`; valid target group headers get `ring-2 ring-ring/30`; invalid targets get `border-dashed opacity-65`. Use `cn()`.
  - Show empty status groups (currently filtered out at line 338) as drop targets when a drag is in progress, so users can drag into empty columns.
- **Pattern:** Follow `KanbanBoard.tsx` drag handlers and CSS classes exactly.
- **Verify:** Build succeeds (`npm run build` in dashboard/). Manual test: drag a card from one status group to another.

### 4. Add inline status dropdown to the table view
- **File:** `dashboard/src/pages/AssignmentsPage.tsx` (MODIFY)
- **What:** In the table view branch, replace the static `<StatusBadge>` cell (lines 321-323) with a `<select>` dropdown styled to match the badge. The dropdown should:
  - Show the current status as the selected value.
  - List all `ASSIGNMENT_BOARD_COLUMNS` as options, with labels from `ASSIGNMENT_COLUMN_LABELS`.
  - Disable options where `getAssignmentAction(assignment, targetStatus)?.disabled` is true, and show the `disabledReason` as the option's title attribute.
  - On change, call `handleMove({ item: assignment, toColumnId: newStatus })`.
  - While `transitioningId` matches, show a loading/disabled state.
  - Style the select using Tailwind to match the StatusBadge color scheme: import `STATUS_META` from StatusBadge and apply the matching `className` dynamically based on current status. Use `appearance-none` plus a small chevron icon for the native select.
- **Pattern:** Reuse `getAssignmentAction` for validation (same as kanban's `canDrop`), `handleMove` for execution (already view-agnostic).
- **Verify:** Build succeeds. Manual test: change status via dropdown in table view.

## Dependencies
- None. All APIs (`handleMove`, `runAssignmentTransition`, `overrideAssignmentStatus`, `getAssignmentAction`) already exist and are view-agnostic.

## Verification
- `cd /Users/brennen/syntaur/dashboard && npx tsc --noEmit` -- type-check passes
- `cd /Users/brennen/syntaur/dashboard && npm run build` -- production build succeeds
- Manual: switch to list view, drag an assignment card to a different status group header, confirm optimistic update and API call
- Manual: switch to table view, click the status dropdown on a row, select a new status, confirm transition
- Manual: verify disabled transitions show as disabled options/invalid drop targets in both views
