# Workflow Graph Redesign — Design

**Assignment:** `syntaur-meta/redesign-workflow-transitions-graph-dual-graphtable-mode`
**Date:** 2026-06-21
**Status:** Approved design → implementation planning

## Problem

The Transitions graph on the dashboard `/workflow` page (what we call the "workflow
graph") is too small and confusing.

- **Too small:** the canvas is locked to a fixed `h-[460px]` box. In edit mode it shares
  that row with a 320px (`w-80`) inspector, so the graph gets a tiny slice of width.
- **Confusing / hairball:** the default workflow is a hub-and-spoke around `in_progress`
  — roughly 12 edges funnel through that one node (every `start`, `reopen`, `unblock`,
  `review→in_progress`), plus back-edges and parallel edges. dagre's left-to-right layout
  can't untangle that in a small box, so edges cross, command labels overlap, and loud red
  "undefined reference" edges add noise. Everything renders at full intensity at once, with
  no way to focus on one status.

### Current implementation

- `dashboard/src/pages/TransitionsGraph.tsx` — ReactFlow (`@xyflow/react`) canvas, fixed
  `h-[460px]`, dagre auto-layout, drag-to-connect editing, edge labels = command names.
- `dashboard/src/pages/TransitionsSection.tsx` — section wrapper. Edit mode = graph
  (`flex-1`) + `TransitionInspector` (`w-80`) side by side; read-only-defaults mode shows
  the built-in defaults.
- `dashboard/src/pages/transitions-graph-layout.ts` — dagre wrapper (`layoutGraph`, LR).
- `dashboard/src/pages/transitions-helpers.ts` — pure, lib-free graph + validation model
  (`deriveGraph`, `groupTransitions`, `validateTransitions`, `detectOrphanStatuses`,
  `detectUndefinedRefs`). **Keep — this is the source of truth.**
- `dashboard/src/pages/WorkflowPage.tsx` — owns the unified save / dirty / validation
  lifecycle across all four tabs (Statuses, Transitions, Derive Rules, Facts). **Keep.**
- `src/lifecycle/state-machine.ts` → `DEFAULT_TRANSITION_TABLE` — the default 17
  transitions across ~9 statuses; hub-and-spoke around `in_progress`.

## Decision

**Full graph + table dual mode**, with the **table as the primary editing surface** and a
**rebuilt graph as the view/navigator**. Both views render from the same
`EditableTransition[]` and feed the same unified save/validation in `WorkflowPage`. No
data-model change — two views over the existing model.

## Design

### A. Two modes, one source of truth

A **Graph ⇄ Table toggle** (segmented control, top-right of the Transitions section).

- **Table mode — primary authoring.** Compact, scannable editor: columns
  `From · Command · To · Requires reason · ⋯`, grouped by `from` status (reuse
  `groupTransitions`), inline add/remove, dropdowns for from/to (status options) and
  command, per-row validation badges (undefined ref, etc.). Fast bulk edits.
- **Graph mode — view / navigator / sanity-check.** Read-optimized, big, legible.
  Selecting an edge opens the inspector / cross-highlights the table row.

### B. Graph mode — kill the hairball

1. **Room to breathe:** drop fixed `h-[460px]` → responsive tall canvas (`min-h-[600px]`,
   grows with viewport) + a **Fullscreen/Expand** toggle that takes over the page. Inspector
   becomes a **floating drawer** overlaying the canvas, not a column that steals width.
2. **Lifecycle-spine layout:** rank the happy path as a straight spine
   (`pending/draft → ready_for_planning → ready_to_implement → in_progress → review →
   completed`); `blocked`/`failed` as offset side-lanes; `reopen`/`unblock`/
   `review→in_progress` as subtle curved return edges. Tune dagre `ranksep`/`nodesep`;
   keep drag-to-reposition + Re-layout.
3. **Focus mode:** click a status → highlight only its in/out edges, dim the rest (the fix
   for the `in_progress` hub). Click empty canvas → reset.
4. **Edge bundling:** multiple commands between the same `from→to` collapse into one edge
   with stacked labels.
5. **Semantic color:** forward = neutral, exception (`block`/`fail`) = amber, recovery
   (`unblock`/`reopen`) = dashed/subtle. Labels render only for the focused/hovered/
   selected subgraph by default.

### C. Validation, quieter

Keep all existing validation (undefined refs, orphans, ghost nodes) but de-noise: muted
styling + an **"N issues"** chip that, when clicked, lists/zooms to the problems instead of
blasting red across the whole canvas at rest. Same
`validateTransitions` / `detectOrphanStatuses` / `detectUndefinedRefs` logic underneath.

### D. What stays unchanged

`transitions-helpers.ts` (graph/validation logic), the unified save lifecycle in
`WorkflowPage`, the inspector component (`TransitionInspector`), and the read-only-defaults
behavior. The redesign is additive: a table view, a toggle, and a rebuilt graph
presentation layer.

## Acceptance criteria

See the assignment's `assignment.md`. In short: working Graph⇄Table toggle over one model;
table editor as primary authoring; graph no longer fixed-height (responsive + fullscreen +
floating inspector); lifecycle-spine layout; focus mode; edge bundling; semantic color;
de-noised validation; graph↔table cross-highlight; existing tests pass + new tests for
table-mode and layout/focus logic.

## Out of scope

- The mermaid `DependencyGraph` (assignment dependency view) — separate component, not the
  "workflow graph."
- Changes to the status/derive/facts tabs beyond what the toggle requires.
- Any change to the `EditableTransition` wire shape or the status-config save API.
